#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod workspace_target;

use serde_json::{json, Value};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use workspace_target::WorkspaceTarget;

struct Supervisor {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Supervisor {
    fn read(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        if self
            .output
            .read_line(&mut line)
            .map_err(|_| "The local service stopped.")?
            == 0
        {
            return Err("The local service stopped.".into());
        }
        serde_json::from_str(&line)
            .map_err(|_| "The local service returned an invalid response.".into())
    }

    fn request(&mut self, request: Value) -> Result<Value, String> {
        serde_json::to_writer(&mut self.input, &request)
            .map_err(|_| "The local service stopped.")?;
        self.input
            .write_all(b"\n")
            .map_err(|_| "The local service stopped.")?;
        self.input
            .flush()
            .map_err(|_| "The local service stopped.")?;
        self.read()
    }

    fn shutdown(&mut self) {
        let _ = self.input.write_all(b"{\"action\":\"shutdown\"}\n");
        let _ = self.input.flush();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Host {
    runtime: Option<Arc<Mutex<Supervisor>>>,
    selected_import: Mutex<Option<PathBuf>>,
}

#[tauri::command]
async fn choose_import(
    app: tauri::AppHandle,
    host: tauri::State<'_, Host>,
) -> Result<bool, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Wawa workspace", &["c2t"])
        .blocking_pick_file()
        .and_then(|file| file.into_path().ok());
    let chosen = selected.is_some();
    *host
        .selected_import
        .lock()
        .map_err(|_| "Could not open the file picker.")? = selected;
    Ok(chosen)
}

#[tauri::command]
async fn import_workspace(
    host: tauri::State<'_, Host>,
    passphrase: String,
) -> Result<Value, String> {
    let source = host
        .selected_import
        .lock()
        .map_err(|_| "Could not read the selected file.")?
        .clone();
    let Some(source) = source else {
        return Ok(json!({"ok": false, "error": "Choose a transfer file first."}));
    };
    let runtime = host
        .runtime
        .clone()
        .ok_or("The local workspace is not running.")?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .lock()
            .map_err(|_| "The local service stopped.".to_string())?
            .request(json!({"action": "import", "path": source, "passphrase": passphrase}))
    })
    .await
    .map_err(|_| "The local service stopped.".to_string())?
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Unexpected sign-in address.")?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("auth.openai.com" | "chatgpt.com"))
    {
        return Err("Unexpected sign-in address.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Could not open your browser.".into())
}

fn show_workspace_picker(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("workspace-picker") {
        window
            .show()
            .map_err(|_| "Could not open workspace choices.")?;
        window
            .set_focus()
            .map_err(|_| "Could not open workspace choices.")?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "workspace-picker",
        WebviewUrl::App("index.html?desktop=workspace".into()),
    )
    .title("Choose a workspace")
    .inner_size(590.0, 730.0)
    .min_inner_size(480.0, 560.0)
    .build()
    .map_err(|_| "Could not open workspace choices.".to_string())?;
    Ok(())
}

#[tauri::command]
fn open_workspace_picker(app: tauri::AppHandle) -> Result<(), String> {
    show_workspace_picker(&app)
}

#[tauri::command]
fn get_workspace_target(app: tauri::AppHandle) -> Result<WorkspaceTarget, String> {
    workspace_target::read(
        &app.path()
            .app_data_dir()
            .map_err(|_| "Could not find app data.")?,
    )
}

#[tauri::command]
fn set_workspace_target(app: tauri::AppHandle, target: WorkspaceTarget) -> Result<(), String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not find app data.")?;
    workspace_target::save(&data, target)?;
    app.request_restart();
    Ok(())
}

#[tauri::command]
fn close_workspace_picker(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .close()
        .map_err(|_| "Could not close workspace choices.".into())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("connection"))
        .or_else(|| app.get_webview_window("remote"))
        .or_else(|| app.get_webview_window("workspace-picker"))
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn remote_login_url(address: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(address)
        .map_err(|_| "Invalid server address.".to_string())?
        .join("desktop-sign-in")
        .map_err(|_| "Invalid server address.".to_string())
}

#[tauri::command]
fn retry_remote_workspace(app: tauri::AppHandle) -> Result<(), String> {
    let WorkspaceTarget::Remote { url } = get_workspace_target(app.clone())? else {
        return Err("Choose a server workspace first.".into());
    };
    app.get_webview_window("remote")
        .ok_or("Could not retry the server workspace.")?
        .navigate(remote_login_url(&url)?)
        .map_err(|_| "Could not retry the server workspace.".into())
}

fn show_remote_workspace(app: &tauri::AppHandle, address: &str) -> Result<(), String> {
    let url = remote_login_url(address)?;
    let origin = url.origin();
    let loaded_origin = origin.clone();
    let hostname = url.host_str().unwrap_or("server").to_string();
    let title = format!("Wawa · {hostname}");
    let connecting = WebviewWindowBuilder::new(
        app,
        "connection",
        WebviewUrl::App("index.html?desktop=connecting".into()),
    )
    .title("Wawa · Connecting to server…")
    .inner_size(1140.0, 800.0)
    .min_inner_size(680.0, 580.0)
    .build()
    .map_err(|_| "Could not open the connection screen.".to_string())?;
    let close_connecting = connecting.clone();
    connecting.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_connecting.hide();
        }
    });

    let external = app.clone();
    let window = WebviewWindowBuilder::new(app, "remote", WebviewUrl::External(url))
        .title("Wawa · Connecting to server…")
        .inner_size(1140.0, 800.0)
        .min_inner_size(680.0, 580.0)
        .visible(false)
        .on_navigation(move |url| url.origin() == origin)
        .on_page_load(move |window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && payload.url().origin() == loaded_origin
            {
                let _ = window.set_title(&title);
                if let Some(connecting) = window.app_handle().get_webview_window("connection") {
                    if connecting.is_visible().unwrap_or(false) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = connecting.destroy();
                }
            }
        })
        .on_new_window(move |url, _| {
            if url.scheme() == "https" {
                let _ = external.opener().open_url(url.to_string(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|_| "Could not open the server workspace.".to_string())?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![choose_import, import_workspace, open_external, open_workspace_picker, retry_remote_workspace, get_workspace_target, set_workspace_target, close_workspace_picker])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "settings" => {
                show_main(app);
                if let Some(window) = app.get_webview_window("remote") {
                    if let Ok(mut url) = window.url() { url.set_path("/"); url.set_query(Some("view=settings")); let _ = window.navigate(url); }
                } else { let _ = app.emit("open-settings", ()); }
            },
            "workspaces" => { let _ = show_workspace_picker(app); },
            "quit-preview" => app.exit(0),
            _ => (),
        })
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let workspaces = MenuItem::with_id(app, "workspaces", "Switch Workspace…", true, None::<&str>)?;
            let quit = PredefinedMenuItem::quit(app, None)?;
            let app_menu = Submenu::with_items(app, "Wawa", true, &[&settings, &workspaces, &quit])?;
            let edit_menu = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit_menu])?)?;
            let show = MenuItem::with_id(app, "open", "Open Wawa", true, None::<&str>)?;
            let tray_workspaces = MenuItem::with_id(app, "workspaces", "Switch Workspace…", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(app, "quit-preview", "Quit Wawa", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show, &tray_workspaces, &tray_quit])?;
            let mut tray = TrayIconBuilder::new().menu(&tray_menu).tooltip("Wawa");
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;

            match workspace_target::read(&data) {
                Ok(WorkspaceTarget::Remote { url }) => {
                    app.manage(Host { runtime: None, selected_import: Mutex::new(None) });
                    show_remote_workspace(app.handle(), &url)?;
                    return Ok(());
                }
                Err(_) => {
                    app.manage(Host { runtime: None, selected_import: Mutex::new(None) });
                    show_workspace_picker(app.handle())?;
                    return Ok(());
                }
                Ok(WorkspaceTarget::Local) => {}
            }

            let bun = resources.join("bun").join(if cfg!(windows) { "bun.exe" } else { "bun" });
            let mut command = Command::new(bun);
            command.arg(resources.join("tauri-runtime.cjs"))
                .env("C2T_TAURI_RESOURCES", &resources)
                .env("C2T_TAURI_DATA", &data)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            command.creation_flags(0x08000000);
            if std::env::args().any(|arg| arg == "--sample") {
                command.env("C2T_TAURI_DEMO", "1");
            }
            let mut child = command.spawn()?;
            let input = child.stdin.take().ok_or("Could not start the local service.")?;
            let output = BufReader::new(child.stdout.take().ok_or("Could not start the local service.")?);
            let runtime = Arc::new(Mutex::new(Supervisor { child, input, output }));
            app.manage(Host { runtime: Some(runtime.clone()), selected_import: Mutex::new(None) });

            WebviewWindowBuilder::new(app, "startup", WebviewUrl::App("tauri-startup.html".into()))
                .title("Wawa").inner_size(1140.0, 800.0).min_inner_size(680.0, 580.0).build()?;

            let handle = app.handle().clone();
            thread::spawn(move || {
                let ready = runtime.lock().map_err(|_| "The local service stopped.".to_string()).and_then(|mut service| service.read());
                let Some(value) = ready.ok().filter(|value| value["type"] == "ready") else {
                    if let Some(window) = handle.get_webview_window("startup") {
                        let _ = window.eval("document.getElementById('status').textContent = 'The preview could not start.'; document.getElementById('detail').textContent = 'Quit the preview and try again.';");
                    }
                    return;
                };
                let config = json!({ "origin": value["origin"], "token": value["token"], "demo": value["demo"] });
                let initialization = format!("window.chat2tasksTauri = Object.freeze({config});");
                let external = handle.clone();
                let main = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                    .title("Wawa").inner_size(1140.0, 800.0).min_inner_size(680.0, 580.0)
                    .initialization_script(initialization)
                    .on_navigation(|url| url.scheme() == "tauri" && url.host_str() == Some("localhost")
                        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
                    .on_new_window(move |url, _| {
                        if url.scheme() == "blob" { return NewWindowResponse::Allow; }
                        if url.scheme() == "https" { let _ = external.opener().open_url(url.to_string(), None::<&str>); }
                        NewWindowResponse::Deny
                    })
                    .build();
                if let Ok(window) = main {
                    let close_window = window.clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = close_window.hide();
                        }
                    });
                    if let Some(startup) = handle.get_webview_window("startup") { let _ = startup.close(); }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Wawa");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(host) = app.try_state::<Host>() {
                if let Some(runtime) = host.runtime.as_ref() {
                    if let Ok(mut runtime) = runtime.lock() {
                        runtime.shutdown();
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
    });
}

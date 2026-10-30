fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "choose_import",
            "import_workspace",
            "open_external",
            "open_workspace_picker",
            "retry_remote_workspace",
            "get_workspace_target",
            "set_workspace_target",
            "close_workspace_picker",
        ]),
    ))
    .expect("Could not prepare the desktop permissions");
}

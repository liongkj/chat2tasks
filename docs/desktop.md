# Wawa desktop preview

## Build on your computer

Install Node.js 24.13 or later, Bun 1.4.4 or later, Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system. Build on the Mac or Windows architecture you intend to use:

```sh
git clone https://github.com/liongkj/chat2tasks.git
cd chat2tasks
npm ci
npm run tauri:stage
npm run tauri:build
```

The staging step downloads OpenWA, its browser and dependencies. The built app and installers appear under `src-tauri/target/release/bundle/`. Builds are previews and are not signed or notarized for distribution. The Mac build can produce a `.dmg`; the Windows build can produce an NSIS `.exe`. See [Tauri's distribution guide](https://v2.tauri.app/distribute/) for signing and platform-specific details.

## Choose where work runs

The local workspace and its gateway run on your computer and need it to be awake. Closing the window leaves the app in the menu bar; quit Wawa from there to stop it.

For work to continue while your computer sleeps, choose **Use another computer** on the welcome screen, or **Switch Workspace** in the app menu. Enter the HTTPS address of your existing always-on Wawa server and sign in. That server runs its own workspace, WhatsApp connection, and models. See [server setup](docker-stack.md), including [Tailscale access](docker-stack.md#tailscale-access). The app does not install or configure the server for you.

Under **Settings → WhatsApp & chats**, you can instead choose a remote OpenWA gateway while keeping the workspace on your computer. That alone does not keep processing running when the computer sleeps. Changing the selected gateway does not move a WhatsApp session.

## Choose a WhatsApp connection

During setup, choose **Standard** or **Lightweight**. Standard uses a browser in the background. Lightweight uses Baileys without a browser and is experimental: it has been tested offline only, and account restriction risk may be higher. Both are unofficial; consider using a separate test number. Only the chosen connection runs. You can change the choice later in **Settings → WhatsApp & chats**; save and restart Wawa, then link WhatsApp for that connection. Each choice keeps its own session and followed conversations. Switching back preserves the other session; it does not transfer or sign it out.

## Move a workspace

On the source workspace, open **Settings → Workspaces** and export an encrypted transfer with a passphrase. In Wawa, choose the transfer on the welcome screen and enter the passphrase. Tasks, evidence, notes, status, preferences and cached images are copied; connections are paused and must be linked again. Pause the source workspace before enabling the new copy so only one processes messages. The old workspace remains in place. The file includes saved provider credentials protected by the passphrase; store it safely and delete it when no longer needed.

Switching between local and server workspaces does not copy or synchronize their data or WhatsApp sessions. An import is an explicit copy, not automatic sync.

## Chrome companion

In the workspace you want to use, open **Settings → Chrome companion**, download and unzip the extension, then load the folder from `chrome://extensions` with Developer mode enabled. Pin the extension, copy the workspace address shown in Settings, create a pairing code and enter both in the side panel. Allow the requested access and refresh WhatsApp Web. Each browser can be revoked in Settings. A local desktop workspace must be running for its companion to connect; a server workspace must be reachable. If another application takes the local address while Wawa is closed, use the new address shown in Settings and pair again.

The extension is an unpacked preview, not a Chrome Web Store listing. To update an existing unpacked installation, replace files in the same folder, reload the extension and refresh WhatsApp Web; keeping the folder preserves the extension ID and pairing.

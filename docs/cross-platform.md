# One server, multiple computers

Choose one Windows, macOS, or Linux computer to run the workspace. The other computers open the same workspace in a browser or a supported desktop preview. They do not need a separate Chat2Tasks server, database, WhatsApp connection, or model configuration.

The server computer must remain awake and connected while you want messages processed. This is a single-owner workspace: everyone who can sign in sees the same data. Selecting another server in a desktop app does not copy or synchronize data.

## Use an installed desktop as the server

Install the desktop preview on the computer that will host the workspace. On first launch choose **This computer** and complete its setup. Open **Settings → Workspaces → Connect other computers**. Enter the computer's private HTTPS address, a free local port, and a strong workspace password. Quit the app from its menu or tray and reopen it to apply the change. The app keeps the password encrypted with the workspace data; it is not shown again.

For Tailscale Serve, use the server computer's full MagicDNS name from Tailscale as the HTTPS address, including the HTTPS port you choose, such as `https://your-server.your-tailnet.ts.net:8443`. Check `tailscale serve status` before using that port. After the app restarts, run the Tailscale command shown in the sharing settings. Install Tailscale on each client and connect the devices to the same tailnet. On each client choose **Another server**, enter that address, and sign in with the workspace password.

The Tauri desktop preview builds for macOS (Apple Silicon and Intel), Windows x64, and Linux x64. The Linux ARM64 WhatsApp browser is not yet available in the pinned gateway release. The server remains available only while its app and private network connection are running and the computer is awake.

## Use Docker as the server

1. Install Docker with Compose on the chosen server: Docker Desktop with Linux containers on Windows or macOS, or Docker Engine with the Compose plugin on Linux. The server uses a Linux container on all three systems.
2. Clone this repository on the server. Copy `.env.example` to `.env` if you do not already have an `.env` file. Set a strong, unique `APP_PASSWORD` in `.env`; keep the file private. If you set a different `PORT` for a new server, also set `PUBLIC_ORIGIN` to `http://127.0.0.1:YOUR_PORT`. Leave an existing `PUBLIC_ORIGIN` unchanged if you already use this workspace through another address.
3. Start the workspace from the repository directory:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://127.0.0.1:2786` on the server and sign in as `admin` with that password. If you changed `PORT`, use that port instead.
5. Connect an existing OpenWA server and select the conversations to follow. OpenWA is a separate service; see [Docker stack deployment](docker-stack.md) for networking and webhook setup.

The default Compose configuration publishes the app only on the server's own loopback interface. The other computers need an HTTPS route to it. The following private-network option works with the existing Compose configuration; an authenticated HTTPS reverse proxy is another option.

## Connect the clients with Tailscale

Install Tailscale on the server and each client, sign the devices in to the same tailnet, and enable MagicDNS and HTTPS certificates for that tailnet. Tailnet access rules must allow the clients to reach the server.

1. On the server, check `tailscale serve status`. Choose an unused HTTPS port; the example below uses 8443. Do not replace an existing route. Confirm `APP_PASSWORD` is set before creating the route.
2. On the server, run:

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:2786
   ```

   Use the local Compose port if it is not 2786. If Tailscale asks to enable HTTPS, follow its prompt and run the command again. Copy the exact HTTPS origin shown by Tailscale, including the port.
3. Add that origin to `ADDITIONAL_ORIGINS` in the server's private `.env`, keeping any existing comma-separated origins. For example, `ADDITIONAL_ORIGINS=https://your-server.your-tailnet.ts.net:8443`. Keep your existing `PUBLIC_ORIGIN` and recreate the service with `docker compose up -d`. An additional remote origin requires `APP_PASSWORD`, including when another proxy provides authentication.
4. On each client, open that HTTPS address in a browser. Sign in as `admin` with the server's password. In the Tauri desktop preview, choose **Connect to a server** or **Switch Workspace**, enter the same HTTPS address, and sign in.

The server's Chrome companion can be downloaded and paired separately on each client. See [Chrome companion](../README.md#chrome-companion). Tailscale Serve is private to your tailnet; access also depends on its access rules. This setup does not enable Tailscale Funnel or create a public route.

## Move the server

There is no automatic election or failover. To change which computer hosts the workspace, first stop or pause processing on the old server, take a consistent backup, and transfer the workspace and credentials to the new host. Include the SQLite data, `vault.key`, Codex session, and any separately hosted OpenWA session you need. Start processing only on the new host, then point each client to its new HTTPS address. Do not run two processors against one live SQLite database or leave two copies processing the same conversations. See [workspace transfer](../README.md#macos-app) and [updating an existing stack](docker-stack.md#update-an-existing-stack).

## Checks and platform limits

GitHub Actions checks the application on Linux, macOS, and Windows. Its Linux job also runs the extension browser journey and builds the Docker image. Separate workflows build desktop previews and make their installers available as workflow artifacts. These checks do not publish a release or automatically update a running server. See [the workflows](../.github/workflows).

The desktop prevents starting the same local workspace twice on one computer. Automatic server discovery, cross-computer ownership handover, and automatic failover are not provided by this preview. The owner must not run copies of the same workspace on separate computers at once.

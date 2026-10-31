# Wawa server setup

The always-on server holds the active workspace and runs its configured model connection while your computer is asleep. You maintain the server, its access, updates and backups. The application and downloadable Chrome companion are built together. Docker Swarm is not required. Keep an existing installation’s selected image name, data mounts, Codex session volume, and network when updating it.

## Set up a new server

On the Linux server, run:

```sh
curl -fsSL https://raw.githubusercontent.com/liongkj/chat2tasks/main/scripts/install-server.sh | bash
```

The installer offers to install Docker and Tailscale if they are missing. It creates a new workspace and OpenWA gateway, sets up their private API connection, and gives you a Tailscale address. Choose a workspace password when prompted. In the Mac app, select **Use another computer**, enter the address and password, and follow the setup screens. You still need to link WhatsApp on your phone, select conversations and sign in to Codex; the WhatsApp API key is handled for you.

Codex on a remote server uses a one-time device code. You may need to enable device-code sign-in in your ChatGPT security settings. The server must stay awake and online. Back up the installer folder and the Wawa Docker volumes, including the workspace, OpenWA data, and Codex session. Rerunning the installer uses its existing workspace. It refuses to take over a different Wawa Docker project or an existing Tailscale route.

This installer creates a new WhatsApp session; it does not move an existing session. To use an existing workspace such as Legion, connect to that workspace instead of installing another one. For a different installation location, set `WAWA_INSTALL_DIR` before running the script.

## Manual setup

The following alternative starts only the Wawa workspace. OpenWA remains a separate service and needs to be installed and configured independently.

## New stack

Before starting, install Docker and Compose on an always-on machine. Set up an OpenWA gateway separately and keep its address and API key available. The commands below start only the Wawa workspace. After they complete, configure the gateway under **Settings → WhatsApp & chats**, sign in to Codex or configure a model in Settings, and choose your conversations. Then follow the HTTPS or Tailscale instructions below before connecting from another device. Back up the persistent data and Codex volumes, and keep both services updated.

```sh
git clone https://github.com/liongkj/chat2tasks.git
cd chat2tasks
cp .env.example .env
docker compose up -d --build
```

Open `http://127.0.0.1:2786`. The default stack publishes only on loopback. Its named volumes persist tasks and Codex sessions across container replacement. Download the companion under **Settings → Chrome companion**; the extension runs in Chrome, while the backend runs in Docker.

For an existing OpenWA Docker stack, attach Chat2Tasks to the same external network using your Compose override. Set its OpenWA URL to the API service’s Docker hostname. Register the signed callback at `http://CHAT2TASKS_SERVICE:2786/api/webhooks/openwa`, and allow that exact callback hostname in OpenWA’s `SSRF_ALLOWED_HOSTS`.

## HTTPS and pairing

Set `PUBLIC_ORIGIN` to your actual HTTPS workspace origin. Set a strong `APP_PASSWORD`, or use `TRUST_PROXY_AUTH=true` only when access is already authenticated by a proxy or private authenticated network. The web username is `admin` when using `APP_PASSWORD`. Protect the full workspace as well as the pairing-code creation page.

Example Caddy route, with both services on the same Docker network:

```caddyfile
tasks.example.com {
    reverse_proxy chat2tasks:2786
}
```

Preserve the original `Host` and `Origin`. The server validates the workspace origin for owner mutations. Companion requests use their own extension origin, a device token, and `X-Chat2Tasks-Extension`; the proxy must pass those headers through. Do not replace all origins with localhost or add wildcard CORS.

## Tailscale access

Join the server and desktop to the same tailnet. Enable HTTPS for the tailnet, inspect `tailscale serve status`, and choose a free HTTPS port. For a Chat2Tasks service published on the server's loopback port 2786, a route can be created with:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:2786
```

The existing Tailscale configuration may already use that port; choose another rather than replacing it. Keep the existing `PUBLIC_ORIGIN`, and add the exact resulting HTTPS origin to `ADDITIONAL_ORIGINS`. Set a strong `APP_PASSWORD` before enabling a remote additional origin. This requirement also applies when `TRUST_PROXY_AUTH=true`: a direct Tailscale route does not pass through the other proxy's sign-in. Apply these settings using your existing deployment files and restart the service only when ready. Use the Tailscale URL in the desktop preview's workspace selector, then enter the workspace password. Desktop sign-in uses a 30-day, HTTP-only session cookie; changing the workspace password invalidates it. The remote workspace continues running only while the server, its WhatsApp connection and its configured processing are active.

## MCP access

Set a separate random `MCP_TOKEN` of at least 32 characters in your private `.env`, then recreate the service. The Compose file passes it to Chat2Tasks; without it, `/mcp` returns 404. Connect a Streamable HTTP MCP client to your HTTPS workspace origin followed by `/mcp`, with `Authorization: Bearer YOUR_MCP_TOKEN`. See [MCP issue triage](technical-reference.md#mcp-issue-triage) for the tools and write boundaries.

Preserve the original `Host` and bearer `Authorization` header. The app authenticates `/mcp` independently of its web Basic login. If the proxy adds authentication, give `/mcp` a route that preserves MCP bearer access while keeping the web workspace protected. Do not replace the MCP bearer header with a web Basic credential. There is no OAuth flow or long-lived SSE stream to configure. Origin-less model clients are accepted; unexpected browser origins are rejected. Changing the token revokes previous MCP clients after service recreation.

## Update an existing stack

1. Commit or otherwise preserve local source changes, fetch the intended revision, and inspect its changes.
2. Build the updated image using your existing image reference. Build before stopping the running application.
3. Stop the application briefly and back up its persistent data and Codex session directory. Include `vault.key` with the database. On Fedora, preserve appropriate SELinux labels; a shared bind mount uses `:z`.
4. Recreate the service through the same Compose project and files. Do not start two processors against one live SQLite database.
5. Confirm health, task/tick preservation, source-media access, signed OpenWA delivery, and companion pairing through the real HTTPS proxy. Revoke any deployment-test device afterwards.

For a stack that already uses a private override file:

```sh
docker build -t YOUR_EXISTING_IMAGE_REFERENCE .
docker compose -p YOUR_EXISTING_PROJECT -f YOUR_STACK_FILE up -d --no-build --pull never
```

Use the same stack file for future restarts and updates. An override containing the complete stack can be used by itself; do not accidentally combine it with a default file that introduces different volumes or ports. Keep private overrides, `.env`, session files, and backups outside Git.

## Verification

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:extension
```

The extension E2E uses a disposable Chromium profile and sample workspace. Localhost access is pre-approved in its fixture manifest because Chrome’s native optional-host approval bubble requires a person. The test runs the built extension code, real Chrome extension storage, and actual backend HTTP routes; it checks pairing, notes, completion, chat activation, reviewed capture, API scope, and revocation. The in-page journey serves a local WhatsApp-shaped fixture at an intercepted WhatsApp URL and checks ID-based TODO links, cross-chat topics, unchanged drafts, original-chat navigation, durable manual moves and revocation. A second journey checks exact source navigation and phone focus return in the full workspace. These fixtures do not access a personal browser profile or real WhatsApp messages. Normal installations must allow the WhatsApp Web site access.

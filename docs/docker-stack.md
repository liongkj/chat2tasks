# Docker stack deployment

The application and downloadable Chrome companion are built together. A Docker Compose stack is sufficient; Docker Swarm is not required. OpenWA remains a separate service. Keep an existing installation’s selected image name, data mounts, Codex session volume, and network when updating it.

## New stack

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

The extension E2E uses a disposable Chromium profile and sample workspace. Localhost access is pre-approved in its fixture manifest because Chrome’s native optional-host approval bubble requires a person. The test runs the built extension code, real Chrome extension storage, and actual backend HTTP routes; it checks pairing, notes, completion, chat activation, reviewed capture, API scope, and revocation. It does not access a personal browser profile or real WhatsApp messages. A normal installation still presents Chrome’s permission prompt.

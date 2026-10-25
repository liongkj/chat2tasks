# Chat2Tasks

A little less to keep in mind. Turn selected WhatsApp conversations into clear, traceable tasks, with your choice of AI model.

Self-hosted, Docker based, and written in TypeScript: React + Vite, Fastify, and SQLite. The workspace starts with your followed conversations. Saved messages and their linked tasks stay side by side, with blockers, next steps, and completion criteria visible in the task panel. All tasks, activity, and connection settings remain one step away.

![Conversation-led workspace with illustrative sample data](docs/qa/context-first/desktop.jpg)

## Start with Docker

```sh
git clone https://github.com/liongkj/chat2tasks.git
cd chat2tasks
cp .env.example .env
docker compose up -d --build
```

Open **http://127.0.0.1:2786**. Open **Settings → Connections** and enter your OpenWA server URL and API key. Find a session and its chats, or add a chat by ID. New chats start paused; activate only the conversations you want to follow. Enter a callback URL reachable from OpenWA, ending in `/api/webhooks/openwa`, then choose **Connect & test webhooks**. The app registers signed message and session events and verifies a delivery. For a private Docker hostname, add only that exact receiver hostname to OpenWA’s `SSRF_ALLOWED_HOSTS`; keep SSRF protection enabled.

OpenWA is a separate prerequisite. Point Chat2Tasks at an existing compatible OpenWA installation. If it is another Compose stack, attach Chat2Tasks to that stack’s network with a Compose override. `localhost` inside the container refers to Chat2Tasks, not your host; on Docker Desktop use `host.docker.internal` for a host service. On Linux configure `host-gateway` or a shared Docker network.

The default port is 2786. If you change `PORT` in `.env`, also set `PUBLIC_ORIGIN=http://127.0.0.1:YOUR_PORT`.

## Conversations and tasks

Choose a followed chat to read its cached messages. Selecting a linked task highlights the messages used as evidence. On mobile, each linked task appears beside its source; choose **View task** to open its full details, then return to the same conversation. Incoming message labels identify the saved conversation, since OpenWA sender identities are not part of this workspace contract.

**All tasks** provides workspace search, conversation filters, and Open / Completed / All views. A task’s completion criteria are always shown before its completion control. **Add missing information** opens the task’s personal note; saving a note does not change the source messages or automatically change its readiness state.

**Activity** separates the most recent signed message event from the last completed task analysis. These are different from the browser’s connection to the workspace server.

## Task references and links

Each task has a permanent reference such as **TODO-001**, shown as a tag in the task list and details. References remain the same when tasks are edited, completed, or reordered. Existing workspaces receive references automatically without changing their tasks or completion records. Search by reference in the workspace, Chrome companion, or MCP tools.

Selecting a task updates the address with `task=TODO-001`. The selected view and conversation are also kept in the address. Refreshing, sharing the address, or using browser Back/Forward restores the selection. **Copy link** in task details copies the current task link. Conversation links also preserve `context=conversation`, and links using older internal task IDs still work. A link to a completed task opens it in the completed list; an unknown reference shows **Task not found**.

If task analysis grouped an issue incorrectly, open **Notes & handoff → Merge tasks…**, choose the correct existing TODO, and confirm the merge. Save any draft note first. Source messages move to the destination; its description, personal note and completion tick stay unchanged. The original personal note remains under **Merged tasks**, and the retired TODO's reference and internal-ID links open the destination. Pending completion questions follow the destination too. Repeated merge requests are safe, and changed tasks reject a stale merge.

An owner-approved merge can combine conversations. Those linked messages become evidence for the combined TODO and can be sent to the configured model during later analysis of either conversation, including evidence originally saved from a now-paused conversation. Automatic processing preserves retired-ID redirects and receives the manual grouping as context. Unrelated conversations cannot be attached by task generation.

## Chrome companion

The optional Manifest V3 extension keeps your tasks beside WhatsApp Web using the same server, model connections, and processing queue. It can search and complete tasks, save notes, activate or pause followed conversations, and request **Find tasks now** from its options menu. Expand a task to see its steps and source; **View conversation in workspace** opens that specific task's original messages. Use **Notes & details** for notes and completion criteria, and **Filter tasks** for search and conversation filters. To capture text, select it in WhatsApp Web, right-click **Capture selection in Chat2Tasks**, then review the text and choose its destination conversation before saving. It does not scrape conversation history or send WhatsApp replies.

[Preview with fictional sample data](docs/companion.png).

1. Open **Settings → Chrome companion** in your full workspace. Download the extension ZIP and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. Pin Chat2Tasks from Chrome’s Extensions menu, then click it to open the side panel.
3. In your full workspace, create a pairing code. Enter your server address and that code in the companion, then approve Chrome’s access prompt for that server. Codes are single use and expire after five minutes. Use HTTPS for remote servers; HTTP localhost is supported for local Docker use.
4. Each browser has its own revocable token, valid for 90 days. Revoke it under **Chrome companion**, or choose **Disconnect** in the panel. Model provider keys never leave the server. Only token hashes are stored in the server database; the browser stores its own device token in Chrome’s local extension storage, restricted to trusted extension contexts. Selection drafts stay in session storage until saved or discarded.

The extension asks for access to the chosen server when connecting. It has no content scripts, remote code, analytics, or automatic page capture. Changing servers requires pairing again. Task-list refreshes do not invoke a model. Saved selections follow your existing automatic debounce/decision settings or remain pending in manual mode. Captures retain browser provenance and are not treated as authenticated outgoing WhatsApp completion reports. Existing source images can be opened in the full workspace.

The downloadable build is included in every Docker image at `/downloads/chat2tasks-chrome.zip`. This is an unpacked extension release; it is not a Chrome Web Store listing. Development source lives in `extension/`; `npm run build` produces both the server and the extension. The ZIP contains only the built extension, without local data or credentials.

For a reverse proxy, set the exact external `PUBLIC_ORIGIN` and preserve the original `Host` and `Origin` headers. Companion API routes authenticate a device token and extension ID separately from the owner’s web session. If a proxy rewrites extension origins to the website origin, pairing will be rejected. See [Docker stack deployment](docs/docker-stack.md).

## Model connections

Use **Settings** to add, name, test, and select connections. Choose **Use connection** on a model to select it for task generation. The separate **Decision connection** setting chooses the trigger judge. Native decision connections cannot be selected for task generation. In-flight requests finish on the connection they started with. Model IDs are editable; there is no fixed provider catalog. Manual processing is available under the task list's **More task actions → Find tasks now**; it is secondary to completing tasks.

* **Codex subscription.** Sign in once inside the running container:

  ```sh
  docker compose exec chat2tasks codex login --device-auth
  ```

  Choose a model supported by your account. Codex sessions persist in the `codex-home` volume. Calls run without shell, app, plugin, or skill tools. The default model carries forward the original app’s configuration; change it if your account exposes different IDs.
* **OpenAI-compatible API.** Supply a base URL ending at the API version (for example `https://api.openai.com/v1`), an API key, and a model ID. OpenAI, OpenRouter and compatible local servers can use this adapter. **Load models** queries `/models` if the endpoint supports it; manual IDs always work. Providers must support non-streaming Chat Completions with JSON text responses. Screenshot analysis also requires image input support.
* **Cloudflare AI Gateway proxy.** Supply your account ID, gateway ID, OpenAI provider key, and an optional authenticated-gateway token. Requests use the OpenAI provider-native proxy with the provider key in `Authorization` and the gateway token in `cf-aig-authorization`. Other compatible gateway paths can be configured using a compatible API connection.
* **Cloudflare REST API with unified billing.** Select unified billing and use a Cloudflare token with **Account → Workers AI → Read** permission. Model IDs use `author/model`, or `@cf/author/model` for Workers AI. Calls use `/accounts/{account}/ai/v1/chat/completions` and `cf-aig-gateway-id`, following [Cloudflare’s current REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/). Model access, credits and billing remain with your provider.

**Test connection** makes one small, billable model request. Saving a connection does not run a test; normal active-chat processing continues in the background. Selected models must return valid schema JSON. Invalid task output is rejected without marking its source messages processed.

## MCP issue triage

Connect an external model to the saved Chat2Tasks issues and their evidence through `/mcp`. The endpoint uses [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), with a separate bearer token. It is disabled until you set `MCP_TOKEN`.

1. Generate a token with `openssl rand -hex 32`, and save it as `MCP_TOKEN` in your private `.env`. Tokens must have at least 32 characters. Recreate the service with `docker compose up -d --build`.
2. In an MCP client that supports Streamable HTTP and custom authorization headers, configure:

   | Setting | Value |
   | --- | --- |
   | URL | `http://127.0.0.1:2786/mcp`, or your HTTPS workspace origin followed by `/mcp` |
   | Transport | Streamable HTTP |
   | Authorization header | `Bearer YOUR_MCP_TOKEN` |

3. Ask the connected model to review open issues, read their original evidence, and save their triage. The `triage_issues` prompt provides the workflow to clients that support MCP prompts.

| Tool | Purpose |
| --- | --- |
| `list_tasks` | Search tasks and filter by completion, priority, or triage state. Defaults to open tasks. |
| `get_task` | Read a task, its exact source messages, cached image observations, and current revision. |
| `list_conversations` | List followed conversations, including paused ones. |
| `get_conversation` | Read saved conversation messages, newest first. |
| `get_source_image` | Read an original source screenshot from the private cache, or retrieve it from the configured OpenWA server. |
| `triage_task` | Update an existing task's title, scope, evidence note, priority, state, next steps, completion criteria, and blocking question. |

List tools and conversation reads support `offset` and `limit`, with a maximum of 100 items per page. `triage_task` requires all triage fields and the `expected_revision` returned by `get_task`. If the task, personal notes, completion tick, or cited evidence changed, the write is rejected; read the task again and reassess. A `needs_info` state requires a concrete blocking question.

Triage preserves completion ticks, personal notes, and source links, and leaves pending messages available for normal processing. The tools do not create tasks, change settings, send WhatsApp replies, or execute task instructions. Model/provider credentials are never returned. The MCP token grants access to this single-owner workspace's saved tasks, messages, notes, and images, including paused conversations. Normal task extraction remains independent and may revise task descriptions when new messages arrive. Connecting and reading do not invoke the app's models; model usage in your MCP client follows that client's provider settings.

For a reverse proxy, preserve `Host` and `Authorization`. `/mcp` uses its bearer token independently of the web workspace's Basic authentication. If your proxy imposes its own login, configure `/mcp` to reach Chat2Tasks with the MCP bearer header intact; keep the workspace protected. Origin-less model clients are supported; browser requests with an origin outside the configured workspace origins are rejected. Use HTTPS for remote connections. Rotate access by changing `MCP_TOKEN` and recreating the service; clearing it disables the endpoint. This endpoint does not provide OAuth or the older HTTP+SSE transport.

## Message receipt and model triggers

Receiving a message does not run Luna. The stages are independent:

1. OpenWA sends `message.received`, `message.sent`, `message.edited`, `message.revoked`, and `session.status` webhooks. Chat2Tasks verifies the HMAC over the exact raw bytes and deduplicates delivery retries. Messages in activated conversations are saved immediately, even in manual mode. Events for other chats are ignored.
2. In automatic mode, a durable per-chat debounce waits for the chosen quiet period, capped at three minutes for a continuous burst. It survives a restart. There is no recurring OpenWA message poll. A source-history reconciliation runs at startup, on session-status changes, configuration changes, and explicit recovery.
3. An optional decision connection chooses **run**, **wait**, or **skip** before task analysis. Codex or an ordinary API connection can return schema-validated decisions. **OpenAI Decisions** calls [`POST /v1/decisions`](https://developers.openai.com/api/docs/guides/decisions) with `gpt-6-luna`; **Jev** calls TypeSafe’s native [`POST /v1/systemone`](https://docs.typesafe.ai/introduction/quickstart) with typed choice criteria. Add either under model connections and select it as the decision connection. They require their respective API keys; a Codex subscription is a separate connection.
4. Low confidence, decision-service failures, attachment evidence, and outgoing completion evidence conservatively run the task model. A **wait** cannot extend a burst beyond three minutes. A **skip** marks only the evaluated batch processed; source messages remain saved. Skipped chatter does not generate task work. These are application policies, not claims that provider confidence is calibrated for your chats.
5. In **manual** mode, webhook receipt continues, but neither the decision model nor Luna runs until you choose **Run now**. **Run now** also bypasses the debounce and decision gate in automatic mode.

The default connection is Codex. A fresh workspace selects Codex for the decision gate too; all trigger choices are configurable in Settings. The browser refreshes displayed state periodically; that does not poll OpenWA or invoke any model.

## Task analysis and persistence

Screenshots are cached against their source message, read as evidence, and reread when their bytes change. Original images appear with source messages. Older unavailable images are retried in bounded batches during triggered work; deleted or expired media can remain unavailable.

Task generation and an evidence review produce next steps, completion criteria, priorities, and exact source links. Source messages and images are untrusted evidence. The app never sends WhatsApp replies or executes task instructions. Only a clear outgoing completion report can automatically tick one task. Ambiguous matches ask locally. Manual changes win, including changes during inference. Task generation cannot change ticks or personal notes.

Notes, task completion, trigger decisions, and usage persist in SQLite. Export includes tasks and cached source messages; import changes only matching task ticks. Task handoffs download as Markdown. Rate-limit retries are bounded jobs, not periodic message polling.

## Privacy and network access

The Docker service binds to host loopback by default. It is a single-owner workspace, not a multi-user service. Before exposing it beyond your computer, set its exact `PUBLIC_ORIGIN` and a strong `APP_PASSWORD`; the username is `admin`. Use HTTPS through your reverse proxy. If a proxy already authenticates every request, you may explicitly set `TRUST_PROXY_AUTH=true` instead.

API keys are encrypted with AES-256-GCM in SQLite. The encryption key is `data/vault.key`, permission 0600, in the same persistent volume. This protects copied database files, **not a compromised host or complete volume**. Keep the database and key backed up together, protect the Docker host, and use disk encryption where appropriate. Credentials are write-only in the UI: a blank field keeps the existing key, a new value replaces it, and **Remove saved key** removes it on save. No keys enter browser storage or workspace exports.

Activated chat messages go to your separately selected decision provider when the decision gate is enabled. Task messages and screenshots go to your task-generation provider, and through Cloudflare when configured. Cloudflare request logging is disabled on requests from this app. Provider retention policies still apply. Self-hosted fonts and assets make no external browser requests. Do not commit `.env`, `config.json`, `data/`, Codex sessions, chat exports, or private images. These are excluded from both Git and Docker build context.

## Existing Python app migration

Chat2Tasks uses the original SQLite tables for tasks, ticks, remarks, source links, image readings, usage and completion history. Before migration, stop the original service and take a consistent backup of its `data/` and Codex-session directory. Start Chat2Tasks with that same data directory mounted at `/app/data`. Optionally mount the original `config.json` at `/app/config.json` read-only for the first start. It imports the selected session/chat, OpenWA URL/key-file and Codex model into new settings; the imported chat appears as **Imported conversation**, which you can rename in settings. Existing image cache filenames remain compatible.

Use a copy first. Additional tables are created without dropping original tables. If rolling back, stop Chat2Tasks before restarting the original service. Never run both processors against one live database.

Set `SYNC_DISABLED=true` for a migration check against a copied data directory; it disables background work and the Run now button. It does not make the workspace read-only: manual edits and explicit connection tests still work.

## Local development

Requires Node.js 24.13 or later.

```sh
npm ci
npm run build
npm test
npm start
```

For UI development, run `npm run dev` and `npm run dev:ui` in separate terminals. The Vite UI proxies `/api` to the service. `npm run check` validates all TypeScript boundaries.

For an explicitly synthetic sample workspace without OpenWA or AI calls:

```sh
npm run build
DEMO=true DATA_DIR=work/demo-data PORT=2787 npm start
```

Open http://127.0.0.1:2787. Keep demo data separate from real data. The sample uses fictional conversations and has no external connections.

## License

[MIT](LICENSE).

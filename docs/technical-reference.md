# Wawa technical reference

## Tasks and conversations

The sidebar separates **Tasks**, **Actions**, **Questions**, **Reminders**, and **Waiting for**, with an **All items** view. Tasks are substantial work or actionable issues; actions are concrete one-step work; questions are for the workspace owner to answer; reminders are lightweight updates or follow-ups. Waiting for tracks an expected result from someone else, either on its own or linked to work. Marking a wait received does not complete its linked task. Automatically matching a reply requires an outgoing source message; a wait added manually without one can be marked received or reopened by the owner. **Review** holds uncertain categories and possible replies. Choosing **Still waiting** dismisses that particular suggested reply while allowing later or edited replies to be considered. Status and conversation filters narrow item views. Search by title, text or TODO reference; **⌘/Ctrl K** moves to workspace search. **More task actions → Show all items** includes open and completed items together.

Use **Organize** on an item to set a project, area of responsibility, date, or Someday/Maybe commitment. Tasks and actions can repeat daily, weekly, monthly, or yearly; completing one occurrence advances the next date without completing the series. **Upcoming** shows active items with owner-entered dates and repeating work; past dated events leave that view. Source-stated times remain in the item text until you add a structured date. Reminders and dates appear in the app only; the app sends no notifications or messages.

Use the category selector in an item's details to correct it. The choice preserves its TODO reference, evidence, notes, and completion state, and later model updates cannot override it. Older items start as tasks until reviewed or changed. **Check category** means the review was uncertain or unavailable; choose the right category or keep the current one. See the [work-item domain](work-item-domain.md) for the rules.

Select a task to read its document. Expand its original messages to inspect text, quotes and cached attachments. **Notes & handoff** holds personal notes, link copying, handoff downloads and manual merging. Saving a note does not change source messages or automatically change readiness. **Mark complete** and **Reopen task** save your manual decision; the confirmation's **Undo** restores the previous completion state. Completion criteria are plain requirements, rather than separately ticked subtasks.

On a phone, the queue comes first. Selecting a task opens a full-screen document; **Back to work** returns to the queue and restores focus. Readiness and conversation filters are in the navigation drawer.

Choose **Conversations** to read a followed chat's cached messages and linked task annotations. Selecting a linked task highlights its evidence. On mobile, **View task** opens its details and returns to the same conversation. Incoming message labels identify the saved conversation, since OpenWA sender identities are not part of this workspace contract. In this conversation view, **Add missing information** opens the same personal note.

**Activity** separates the most recent signed message event from the last completed task analysis. These are different from the browser’s connection to the workspace server.

## Task references and links

Each task has a permanent reference such as **TODO-001**, shown as a tag in the task list and details. References remain the same when tasks are edited, completed, or reordered. Existing workspaces receive references automatically without changing their tasks or completion records. Search by reference in the workspace, Chrome companion, or MCP tools.

Selecting a task updates the address with `task=TODO-001`. The view, conversation filter, search and readiness filter are also kept in the address; for example, `state=needs_info` restores the blocked-task view. Refreshing, sharing the address, or using browser Back/Forward restores that context. **Notes & handoff → Copy link** copies the current task link. `context=conversation` expands the original messages in Task desk, and older internal task IDs still work. A link to a completed task opens it in the completed list; an unknown reference shows **Task not found**.

If task analysis grouped an issue incorrectly, open **Notes & handoff → Merge tasks…**, choose the correct existing TODO, and confirm the merge. Save any draft note first. Source messages move to the destination; its description, personal note and completion tick stay unchanged. The original personal note remains under **Merged tasks**, and the retired TODO's reference and internal-ID links open the destination. Pending completion questions follow the destination too. Repeated merge requests are safe, and changed tasks reject a stale merge.

An owner-approved merge can combine conversations. Those linked messages become evidence for the combined TODO and can be sent to the configured model during later analysis of either conversation, including evidence originally saved from a now-paused conversation. Automatic processing preserves retired-ID redirects and receives the manual grouping as context. Unrelated conversations cannot be attached by task generation.

## Chrome companion

The optional Manifest V3 extension adds a **Chats | Threads** switch to WhatsApp Web. Normal Chats shows only a quiet TODO reference on linked messages. Threads groups discussions across the conversations connected to your server, keeps each original message and source chat, and opens that chat when you choose **Reply in…**. It does not send a reply. A topic can exist without a TODO. **Move** puts a message in another topic, a new topic, or Other messages; your correction persists through automatic organisation, source edits, and restart.

The side panel separates and searches the item categories, shows waiting items and their evidence, lets you correct a category or complete an item or occurrence, saves notes, activates or pauses followed conversations, and offers **Find tasks now**. Create waits and edit organization in the full workspace. **View conversation in workspace** opens an item's evidence. To capture selected text, right-click **Capture selection in Wawa**, review it and choose its destination conversation before saving.

[Preview with fictional sample data](companion.png).

[Chats and Threads: usage, field mapping and browser captures](whatsapp-threads.md).

1. Open **Settings → Chrome companion** in your full workspace. Download the extension ZIP and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. Pin Wawa from Chrome’s Extensions menu, then click it to open the side panel.
3. In your full workspace, create a pairing code. Enter your server address and that code in the companion, then approve Chrome’s access prompt for that server. Codes are single use and expire after five minutes. Use HTTPS for remote servers; HTTP localhost is supported for local Docker use.
4. Each browser has its own revocable token, valid for 90 days. Revoke it under **Chrome companion**, or choose **Disconnect** in the panel. Model provider keys never leave the server. Only token hashes are stored in the server database; the browser stores its own device token in Chrome’s local extension storage, restricted to trusted extension contexts. Selection drafts stay in session storage until saved or discarded.

The extension requests access to WhatsApp Web for its in-page UI and to your selected server when pairing. A bundled content script matches loaded WhatsApp message IDs to saved OpenWA evidence; it does not match by text or archive additional page history. Network credentials stay in the extension service worker, outside the page. There is no remote code or analytics. Changing servers requires pairing again. Update an unpacked installation by replacing files in the same folder, reloading it in `chrome://extensions` or `edge://extensions`, then refreshing WhatsApp Web. Approve the new WhatsApp site access when prompted; keeping the folder preserves the extension ID and pairing.

Threads is also available in the full workspace. First opening it enables organisation using your selected model. Automatic mode organises new or edited saved messages from active chats; in manual mode choose **Organise now**. Paused chats retain their saved history, and pausing during inference discards new assignments for those messages. Browsing an already organised thread does not repeat model calls. Uncertain messages remain under **Other messages**. The source chat opens directly when its name is available in WhatsApp's chat list or search; already loaded source messages are scrolled into view. Older history may need loading in the original chat. Saved selections follow the existing task-analysis settings and retain browser provenance; they are not authenticated outgoing completion reports.

The downloadable build is included in every Docker image at `/downloads/chat2tasks-chrome.zip`. This is an unpacked extension release; it is not a Chrome Web Store listing. Development source lives in `extension/`; `npm run build` produces both the server and the extension. The ZIP contains only the built extension, without local data or credentials.

For a reverse proxy, set the exact external `PUBLIC_ORIGIN` and preserve the original `Host` and `Origin` headers. Companion API routes authenticate a device token and extension ID separately from the owner’s web session. If a proxy rewrites extension origins to the website origin, pairing will be rejected. See [Docker stack deployment](docker-stack.md).

## Model connections

Use **Settings** to add, name, test, and select connections. Choose **Use connection** on a model to select it for item generation. The separate **Decision connection** reviews categories and proposed completions in both manual and automatic modes; in automatic mode it also chooses when analysis runs. Native decision connections cannot be selected for item generation. In-flight requests finish on the connection they started with. Model IDs are editable; there is no fixed provider catalog. Manual processing is available under **More task actions → Find tasks now**.

- **Codex subscription.** Sign in once inside the running container:

  ```sh
  docker compose exec chat2tasks codex login --device-auth
  ```

  Choose a model supported by your account. Codex sessions persist in the `codex-home` volume. Calls run without shell, app, plugin, or skill tools. The default model carries forward the original app’s configuration; change it if your account exposes different IDs.

- **OpenAI-compatible API.** Supply a base URL ending at the API version (for example `https://api.openai.com/v1`), an API key, and a model ID. OpenAI, OpenRouter and compatible local servers can use this adapter. **Load models** queries `/models` if the endpoint supports it; manual IDs always work. Providers must support non-streaming Chat Completions with JSON text responses. Screenshot analysis also requires image input support.
- **Cloudflare AI Gateway proxy.** Supply your account ID, gateway ID, OpenAI provider key, and an optional authenticated-gateway token. Requests use the OpenAI provider-native proxy with the provider key in `Authorization` and the gateway token in `cf-aig-authorization`. Other compatible gateway paths can be configured using a compatible API connection.
- **Cloudflare REST API with unified billing.** Select unified billing and use a Cloudflare token with **Account → Workers AI → Read** permission. Model IDs use `author/model`, or `@cf/author/model` for Workers AI. Calls use `/accounts/{account}/ai/v1/chat/completions` and `cf-aig-gateway-id`, following [Cloudflare’s current REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/). Model access, credits and billing remain with your provider.

**Test connection** makes one small, billable model request. Saving a connection does not run a test; normal active-chat processing continues in the background. Selected models must return valid schema JSON. Invalid task output is rejected without marking its source messages processed.

## MCP issue triage

Connect an external model to the saved Wawa issues and their evidence through `/mcp`. The endpoint uses [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), with a separate bearer token. It is disabled until you set `MCP_TOKEN`.

1. Generate a token with `openssl rand -hex 32`, and save it as `MCP_TOKEN` in your private `.env`. Tokens must have at least 32 characters. Recreate the service with `docker compose up -d --build`.
2. In an MCP client that supports Streamable HTTP and custom authorization headers, configure:

   | Setting              | Value                                                                          |
   | -------------------- | ------------------------------------------------------------------------------ |
   | URL                  | `http://127.0.0.1:2786/mcp`, or your HTTPS workspace origin followed by `/mcp` |
   | Transport            | Streamable HTTP                                                                |
   | Authorization header | `Bearer YOUR_MCP_TOKEN`                                                        |

3. Ask the connected model to review open issues, read their original evidence, and save their triage. The `triage_issues` prompt provides the workflow to clients that support MCP prompts.

| Tool                 | Purpose                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `list_tasks`         | Search tasks and filter by completion, priority, or triage state. Defaults to open tasks.                                       |
| `get_task`           | Read a task, its exact source messages, cached image observations, and current revision.                                        |
| `list_conversations` | List followed conversations, including paused ones.                                                                             |
| `get_conversation`   | Read saved conversation messages, newest first.                                                                                 |
| `get_source_image`   | Read an original source screenshot from the private cache, or retrieve it from the configured OpenWA server.                    |
| `triage_task`        | Update an existing task's title, scope, evidence note, priority, state, next steps, completion criteria, and blocking question. |

List tools and conversation reads support `offset` and `limit`, with a maximum of 100 items per page. `triage_task` requires all triage fields and the `expected_revision` returned by `get_task`. If the task, personal notes, completion tick, or cited evidence changed, the write is rejected; read the task again and reassess. A `needs_info` state requires a concrete blocking question.

Triage preserves completion ticks, personal notes, and source links, and leaves pending messages available for normal processing. The tools do not create tasks, change settings, send WhatsApp replies, or execute task instructions. Model/provider credentials are never returned. The MCP token grants access to this single-owner workspace's saved tasks, messages, notes, and images, including paused conversations. Normal task extraction remains independent and may revise task descriptions when new messages arrive. Connecting and reading do not invoke the app's models; model usage in your MCP client follows that client's provider settings.

For a reverse proxy, preserve `Host` and `Authorization`. `/mcp` uses its bearer token independently of the web workspace's Basic authentication. If your proxy imposes its own login, configure `/mcp` to reach Wawa with the MCP bearer header intact; keep the workspace protected. Origin-less model clients are supported; browser requests with an origin outside the configured workspace origins are rejected. Use HTTPS for remote connections. Rotate access by changing `MCP_TOKEN` and recreating the service; clearing it disables the endpoint. This endpoint does not provide OAuth or the older HTTP+SSE transport.

## Message receipt and model triggers

Receiving a message does not run Luna. The stages are independent:

1. OpenWA sends `message.received`, `message.sent`, `message.edited`, `message.revoked`, and `session.status` webhooks. Wawa verifies the HMAC over the exact raw bytes and deduplicates delivery retries. Messages in activated conversations are saved immediately, even in manual mode. Events for other chats are ignored.
2. In automatic mode, a durable per-chat debounce waits for the chosen quiet period, capped at three minutes for a continuous burst. It survives a restart. There is no recurring OpenWA message poll. A source-history reconciliation runs at startup, on session-status changes, configuration changes, and explicit recovery.
3. An optional decision connection chooses **run**, **wait**, or **skip** before task analysis. Codex or an ordinary API connection can return schema-validated decisions. **OpenAI Decisions** calls [`POST /v1/decisions`](https://developers.openai.com/api/docs/guides/decisions) with `gpt-6-luna`; **Jev** calls TypeSafe’s native [`POST /v1/systemone`](https://docs.typesafe.ai/introduction/quickstart) with typed choice criteria. Add either under model connections and select it as the decision connection. They require their respective API keys; a Codex subscription is a separate connection.
4. Low confidence, decision-service failures, attachment evidence, and outgoing completion evidence conservatively run the task model. A **wait** cannot extend a burst beyond three minutes. A **skip** marks only the evaluated batch processed; source messages remain saved. Skipped chatter does not generate task work. These are application policies, not claims that provider confidence is calibrated for your chats.
5. After drafting, the selected decision connection checks each new item's category against linked evidence. A category needs confidence of at least 0.75 to be applied automatically; otherwise the item stays visible with a category review prompt. A question or action found only in an uncaptioned screenshot always needs owner review, because its intended recipient is unclear. This threshold is provisional, not an accuracy guarantee. The app filters a task candidate only when a separate review identifies it as clearly not an item with confidence of at least 0.95. Proposed waits must cite the owner's outgoing request; uncertain waits, possible replies, and direct attachment-only replies go to Review. Proposed automatic completions receive a separate review of the whole outcome and matching reply; uncertain results ask for confirmation. If no decision connection is selected, the task model performs these reviews. A failed reviewer keeps candidate work visible and requires confirmation for completion.
6. In **manual** mode, webhook receipt continues, but models do not run until you choose **Run now**. In automatic mode **Run now** bypasses the debounce and trigger gate, but still reviews candidates and completions. It also reviews categories of open items and nearby saved replies in active conversations, including previously processed replies. It does not reclassify completed items or override a manual category choice. A clearly irrelevant task may be moved to Completed with a **Not an item** label; reopen it if needed. Tasks with personal notes, manual completion changes, merged tasks, unavailable image evidence, or an uncertain category are not automatically filtered. A manual review makes additional model calls.

The default connection is Codex. A fresh workspace selects Codex for the decision gate too; all trigger choices are configurable in Settings. The browser refreshes displayed state periodically; that does not poll OpenWA or invoke any model.

## Task analysis and persistence

Screenshots are cached against their source message, read as evidence, and reread when their bytes change. Original images appear with source messages. Older unavailable images are retried in bounded batches during triggered work; deleted or expired media can remain unavailable.

Item generation and evidence review produce priorities and exact source links, with next steps and completion criteria when needed. Source messages and images are untrusted evidence. The app never sends WhatsApp replies or executes task instructions. A clear outgoing completion report, or a substantive answer to the exact owner-directed question, can automatically resolve the corresponding item. A reply does not resolve separate unfinished work. Reminders stay until the owner dismisses them. Ambiguous matches ask locally. Manual completion and category changes win, including changes during inference. Item generation cannot change ticks or personal notes.

Notes, task completion, trigger decisions, and usage persist in SQLite. Export includes tasks and cached source messages; import changes only matching task ticks. Task handoffs download as Markdown. Rate-limit retries are bounded jobs, not periodic message polling.

## Privacy and network access

The Docker service binds to host loopback by default. It is a single-owner workspace, not a multi-user service. Before exposing it beyond your computer, set its exact `PUBLIC_ORIGIN` and a strong `APP_PASSWORD`; the username is `admin`. Use HTTPS through your reverse proxy. If a proxy already authenticates every request, you may explicitly set `TRUST_PROXY_AUTH=true` instead.

API keys are encrypted with AES-256-GCM in SQLite. The encryption key is `data/vault.key`, permission 0600, in the same persistent volume. This protects copied database files, **not a compromised host or complete volume**. Keep the database and key backed up together, protect the Docker host, and use disk encryption where appropriate. Credentials are write-only in the UI: a blank field keeps the existing key, a new value replaces it, and **Remove saved key** removes it on save. Keys do not enter browser storage or the ordinary JSON export; encrypted workspace transfer files include the database and its key.

Activated chat messages go to your separately selected decision provider when the decision gate is enabled. Item review also sends relevant saved conversation text, item details, and screenshot readings to the selected decision provider, including explicitly linked evidence from manually merged conversations. Personal notes and owner-entered project, area, and date metadata are excluded from decision reviews. Task messages and screenshots go to your task-generation provider, and through Cloudflare when configured. Cloudflare request logging is disabled on requests from this app. Provider retention policies still apply. Self-hosted fonts and assets make no external browser requests. Do not commit `.env`, `config.json`, `data/`, Codex sessions, chat exports, or private images. These are excluded from both Git and Docker build context.

## Existing Python app migration

Wawa uses the original SQLite tables for tasks, ticks, remarks, source links, image readings, usage and completion history. Before migration, stop the original service and take a consistent backup of its `data/` and Codex-session directory. Start Wawa with that same data directory mounted at `/app/data`. Optionally mount the original `config.json` at `/app/config.json` read-only for the first start. It imports the selected session/chat, OpenWA URL/key-file and Codex model into new settings; the imported chat appears as **Imported conversation**, which you can rename in settings. Existing image cache filenames remain compatible.

Use a copy first. Additional tables are created without dropping original tables. If rolling back, stop Wawa before restarting the original service. Never run both processors against one live database.

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

[MIT](../LICENSE).

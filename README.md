# Wawa

Turn the WhatsApp conversations you choose into tasks, quick actions, questions, reminders, and things you're waiting for. Each item links back to its source so you can check the context.

![Wawa overview with sample data](docs/wawa-overview.png)

## Get started

Wawa is an early open-source preview. There are no published installers yet. To try it, [build the desktop app](docs/desktop.md) on your Mac or Windows computer, then follow the setup screens to:

1. Link WhatsApp as a device and choose which conversations to follow.
2. Sign in to Codex or configure your preferred model connection.
3. Choose when Wawa should review messages.

The desktop app runs its workspace and WhatsApp gateway on your computer. **You do not need Docker for this option.** It processes messages while your computer is awake. An optional Chrome companion puts your items next to WhatsApp Web; pair it from **Settings → Chrome companion**.

To bring an existing workspace, export an encrypted transfer from **Settings → Workspaces**, then import it in the desktop app. The original stays in place. Pause processing in the old workspace before enabling the new copy, and relink its connections. See [workspace transfer](docs/desktop.md#move-a-workspace).

## Keep Wawa working while your computer sleeps

Run this on a Linux server you manage:

```sh
curl -fsSL https://raw.githubusercontent.com/liongkj/chat2tasks/main/scripts/install-server.sh | bash
```

The installer offers to set up Docker and Tailscale if needed, starts a new Wawa workspace and WhatsApp gateway, and connects them privately. It asks you to choose a workspace password and gives you an address to enter in the Mac app. Then link WhatsApp, choose your conversations, and sign in to Codex. The server must stay awake and connected to the internet. You remain responsible for updates and backups; this is not a hosted service. See the [server setup guide](docs/docker-stack.md).

The installer creates a new workspace. To use an existing server workspace, connect the desktop app to that server instead; the installer does not move or replace an existing WhatsApp session.

## WhatsApp and privacy

Wawa uses an **unofficial** WhatsApp connection. WhatsApp may restrict or ban an account linked through it; consider using a separate test number instead of a primary account. Wawa is not affiliated with or endorsed by WhatsApp or Meta. The bundled gateway may retain history beyond the conversations you select. Selected messages and images are sent to your configured AI provider for processing.

The desktop preview uses [OpenWA](https://github.com/rmyndharis/OpenWA). The standard connection uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js); the optional lightweight [Baileys](https://github.com/WhiskeySockets/Baileys) connection is experimental and has only been tested offline. Each option keeps a separate session; switching requires relinking WhatsApp. See [OpenWA's account-risk guidance](https://github.com/rmyndharis/OpenWA/discussions/436).

## Learn more

- [Desktop builds, connections, and workspace transfer](docs/desktop.md)
- [Server setup and secure access](docs/docker-stack.md)
- [Technical reference, model connections, and companion](docs/technical-reference.md)
- [Work-item categories](docs/work-item-domain.md)

The desktop architecture and CLI onboarding were inspired by [bb](https://github.com/get-bb/bb). Wawa does not require bb to be installed. Wawa is released under the [MIT license](LICENSE); its dependencies have their own licenses.

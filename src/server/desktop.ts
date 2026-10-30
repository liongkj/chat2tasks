import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CodexLogin } from './codex-login.js';
import { OpenWA } from './openwa.js';
import { Store, hash } from './store.js';
import { Sync } from './sync.js';
import { Webhooks } from './webhooks.js';

const Session = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  engineLoaded: z.boolean(),
});
const Chat = z.object({ id: z.string(), name: z.string().nullish() });

export async function configureDesktopGateway(store: Store) {
  const url = process.env.DESKTOP_OPENWA_URL;
  const keyFile = process.env.DESKTOP_OPENWA_KEY_FILE;
  const origin = process.env.PUBLIC_ORIGIN;
  if (!url || !keyFile || !origin) return;
  const key = (await readFile(keyFile, 'utf8')).trim();
  const settings = store.settings();
  const profiles = settings.profiles.some((profile) => profile.kind === 'codex')
    ? settings.profiles
    : [
        ...settings.profiles,
        { id: 'desktop-codex', name: 'Codex', kind: 'codex' as const, model: 'gpt-6-luna' },
      ];
  store.saveSettings({
    settings: {
      ...settings,
      profiles,
      openwaUrl: url,
      webhookUrl: origin + '/api/webhooks/openwa',
    },
    secrets: { openwa: key },
    removeSecrets: [],
  });
}

export async function registerDesktop(
  server: FastifyInstance,
  store: Store,
  openwa: OpenWA,
  sync: Sync,
  webhooks: Webhooks,
) {
  const codex = new CodexLogin();
  server.addHook('onClose', async () => codex.stop());
  async function currentSession() {
    const sessions = z.array(Session).parse(await (await openwa.request('/api/sessions')).json());
    return sessions.find((session) => session.name === 'chat2tasks') ?? null;
  }
  async function availableChats(sessionId: string) {
    return z
      .array(Chat)
      .parse(
        await (await openwa.request(`/api/sessions/${encodeURIComponent(sessionId)}/chats`)).json(),
      )
      .map((chat) => ({ id: chat.id, name: chat.name ?? chat.id }));
  }
  server.get('/api/desktop/status', async () => ({
    setupComplete: store.metaValue('desktop_setup_complete') === true,
    imported: store.metaValue('workspace_imported') === true,
    codex: await codex.status(),
  }));
  server.post('/api/desktop/codex/login', async () => ({ url: await codex.start() }));
  server.post('/api/desktop/whatsapp/start', async () => {
    let session = await currentSession();
    if (!session)
      session = Session.parse(
        await (await openwa.request('/api/sessions', 'POST', { name: 'chat2tasks' })).json(),
      );
    if (!session.engineLoaded && session.status !== 'ready')
      session = Session.parse(
        await (
          await openwa.request(`/api/sessions/${encodeURIComponent(session.id)}/start`, 'POST', {})
        ).json(),
      );
    return { status: session.status };
  });
  server.get('/api/desktop/whatsapp/status', async () => {
    const session = await currentSession();
    if (!session) return { status: 'not_connected', qr: null };
    let qr: string | null = null;
    if (session.status === 'qr_ready') {
      try {
        const data = z
          .object({
            qrCode: z
              .string()
              .max(300000)
              .regex(/^data:image\/png;base64,/),
          })
          .parse(
            await (
              await openwa.request(`/api/sessions/${encodeURIComponent(session.id)}/qr`)
            ).json(),
          );
        qr = data.qrCode;
      } catch {
        /* An expired QR will be refreshed by the gateway. */
      }
    }
    return { status: session.status, qr };
  });
  server.get('/api/desktop/chats', async () => {
    const session = await currentSession();
    if (!session || session.status !== 'ready') return { chats: [] };
    return { chats: await availableChats(session.id) };
  });
  server.post('/api/desktop/chats', async (request) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(100) }).parse(request.body);
    const session = await currentSession();
    if (!session || session.status !== 'ready') throw new Error('Connect WhatsApp first.');
    const choices = await availableChats(session.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !choices.some((chat) => chat.id === id))
    )
      throw new Error('Choose conversations from the connected WhatsApp account.');
    const selected: string[] = [];
    for (const id of ids) {
      const matching = store.settings().chats.filter((chat) => chat.chatId === id);
      if (matching.length > 1)
        throw new Error('A conversation needs manual matching before it can be moved.');
      const existing = matching[0];
      if (existing) {
        store.relinkConversation(existing.id, session.id);
        selected.push(existing.id);
      } else {
        const choice = choices.find((chat) => chat.id === id);
        if (!choice) throw new Error('Conversation not found');
        const chatId = hash([session.id, id]);
        const settings = store.settings();
        store.saveSettings({
          settings: {
            ...settings,
            chats: [
              ...settings.chats,
              {
                id: chatId,
                name: choice.name,
                sessionId: session.id,
                chatId: id,
                enabled: false,
              },
            ],
          },
          secrets: {},
          removeSecrets: [],
        });
        selected.push(chatId);
      }
    }
    store.setMeta('desktop_selected_chats', selected);
    return { ok: true };
  });
  server.post('/api/desktop/finish', async () => {
    const selected = z.array(z.string()).min(1).parse(store.metaValue('desktop_selected_chats'));
    const session = await currentSession();
    if (!session || session.status !== 'ready') throw new Error('Connect WhatsApp first.');
    if (!(await codex.status()).signedIn) throw new Error('Sign in to Codex first.');
    await webhooks.connect([session.id]);
    const settings = store.settings();
    const profile = settings.profiles.find((item) => item.kind === 'codex');
    if (!profile) throw new Error('Sign in to Codex first.');
    store.saveSettings({
      settings: {
        ...settings,
        activeProfileId: profile.id,
        chats: settings.chats.map((chat) => ({ ...chat, enabled: selected.includes(chat.id) })),
      },
      secrets: {},
      removeSecrets: [],
    });
    store.setMeta('desktop_setup_complete', true);
    sync.reconfigure();
    return { ok: true };
  });
}

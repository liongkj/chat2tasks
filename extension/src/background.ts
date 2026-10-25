import { z } from 'zod';
import {
  CaptureDraftSchema,
  ConnectionSchema,
  CompanionTaskSchema,
} from '../../src/shared/companion.js';
import {
  AnnotationsSchema,
  ThreadSnapshotSchema,
  ThreadMediaSchema,
  ThreadMoveResultSchema,
} from '../../src/shared/threads.js';
import { PageRequestSchema, type PageRequest } from './page-protocol.js';
import { request, OkSchema } from './api.js';

const MENU = 'chat2tasks-capture';
function configure() {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
chrome.runtime.onStartup.addListener(configure);
chrome.runtime.onInstalled.addListener(() => {
  configure();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU,
      title: 'Capture selection in Chat2Tasks',
      contexts: ['selection'],
      documentUrlPatterns: ['https://web.whatsapp.com/*'],
    });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU || tab?.id === undefined) return;
  // Open while the context-menu user gesture is active, before waiting for storage.
  void chrome.sidePanel
    .open({ tabId: tab.id })
    .catch(() => chrome.action.setBadgeText({ text: '!' }));
  const draft = CaptureDraftSchema.safeParse({
    id: crypto.randomUUID(),
    text: info.selectionText ?? '',
    url: info.pageUrl ?? '',
    title: (tab.title ?? 'WhatsApp Web').slice(0, 256),
  });
  if (!draft.success) {
    void chrome.storage.session.remove('captureDraft');
    void chrome.storage.session.set({
      captureError: 'Choose a smaller selection, up to 16,000 characters.',
    });
    return;
  }
  void chrome.storage.session.set({ captureDraft: draft.data, captureError: null });
  void chrome.action.setBadgeText({ text: '' });
});

const ChatNames = z.object({ serverUrl: z.string(), names: z.record(z.string(), z.string()) });
async function relay(input: PageRequest) {
  const saved = await chrome.storage.local.get(['connection', 'pageChatNames']);
  const parsed = ConnectionSchema.safeParse(saved.connection);
  if (!parsed.success) throw new Error('Pair the companion with your workspace to use Threads.');
  const connection = parsed.data;
  const previous = ChatNames.safeParse(saved.pageChatNames);
  const names =
    previous.success && previous.data.serverUrl === connection.serverUrl ? previous.data.names : {};
  switch (input.kind) {
    case 'annotations': {
      const result = await request(connection, 'annotations', AnnotationsSchema, {
        waIds: input.waIds,
      });
      const chats = [...new Set(result.matches.map((m) => m.conversationId))];
      const id = chats.length === 1 ? chats[0] : undefined;
      if (id && input.chatTitle.trim() && names[id] !== input.chatTitle.trim()) {
        names[id] = input.chatTitle.trim();
        await chrome.storage.local.set({
          pageChatNames: { serverUrl: connection.serverUrl, names },
        });
      }
      return result;
    }
    case 'threads': {
      const result = await request(connection, 'threads', ThreadSnapshotSchema);
      return { ...result, chats: result.chats.map((c) => ({ ...c, name: names[c.id] ?? c.name })) };
    }
    case 'organise':
      return request(connection, 'threads/organise', OkSchema, {});
    case 'enable-threads':
      return request(connection, 'threads/enable', OkSchema, {});
    case 'move':
      return request(connection, 'threads/move', ThreadMoveResultSchema, input.input);
    case 'media':
      return request(
        connection,
        'threads/media/' + encodeURIComponent(input.id),
        ThreadMediaSchema,
      );
    case 'open-task': {
      const result = await request(
        connection,
        'tasks/' + encodeURIComponent(input.id),
        CompanionTaskSchema,
      );
      const url = new URL(connection.serverUrl);
      url.searchParams.set('view', 'tasks');
      url.searchParams.set('task', result.task.reference);
      await chrome.tabs.create({ url: url.href });
      return { ok: true };
    }
    case 'open-panel':
      return { ok: true };
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const input = PageRequestSchema.safeParse(message);
  if (!input.success) return;
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab?.id ||
    !sender.url ||
    new URL(sender.url).origin !== 'https://web.whatsapp.com'
  ) {
    respond({ ok: false, error: 'Use Threads on WhatsApp Web.' });
    return;
  }
  if (input.data.kind === 'open-panel') {
    void chrome.sidePanel.open({ tabId: sender.tab.id }).then(
      () => respond({ ok: true, data: { ok: true } }),
      () =>
        respond({ ok: false, error: 'Open the companion from the browser toolbar to pair it.' }),
    );
  } else {
    void relay(input.data).then(
      (data) => respond({ ok: true, data }),
      (error) =>
        respond({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : 'Could not reach the paired workspace. Open the companion to check its connection.',
        }),
    );
  }
  return true;
});

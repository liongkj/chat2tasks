import { CaptureDraftSchema } from '../../src/shared/companion.js';

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

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import { ThreadView } from '../../src/shared/ThreadView.js';
import { RefreshGate } from '../../src/shared/refresh.js';
import {
  AnnotationsSchema,
  ThreadSnapshotSchema,
  ThreadMoveResultSchema,
  ThreadMediaSchema,
  whatsappMessageKey,
  type ThreadMessage,
  type ThreadSnapshot,
  type ThreadMove,
} from '../../src/shared/threads.js';
import styles from '../../src/shared/thread-view.css';
import { pageRequest } from './page-protocol.js';

const Ok = z.object({ ok: z.boolean() });
type Mode = 'chats' | 'threads';
const uiStyles = `:host{color-scheme:light;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#303439}*{box-sizing:border-box}.c-mode{display:flex;align-items:center;gap:3px;height:40px;padding:5px 12px;background:#fff;border-bottom:1px solid #e1e3e5}.c-mode button{font:inherit;padding:4px 15px;min-height:30px;border:0;border-radius:4px;background:transparent;color:#545c64;cursor:pointer}.c-mode button[aria-pressed=true]{background:#ededee;color:#25292d;font-weight:600}.c-mode button:focus-visible{outline:2px solid #4e5862;outline-offset:2px}.c-smart{display:flex;flex-direction:column;height:100%;background:#fff}.c-smart>.t-workspace{height:auto;flex:1}.c-state{padding:36px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#424950}.c-state button{font:inherit;margin:10px 10px 0 0;padding:9px 14px;background:#fff;color:#303439;border:1px solid #bcc1c6;border-radius:5px;cursor:pointer}.c-error{padding:8px 20px;background:#fff4ef;color:#813d30;font-size:13px}.c-small{margin-left:auto;color:#6a7178;font-size:11px}.c-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#303439;color:white;padding:10px 18px;border-radius:6px;max-width:90vw;font-size:13px;z-index:2147483500}`;

for (const id of ['chat2tasks-threads', 'chat2tasks-modes']) document.getElementById(id)?.remove();
for (const node of document.querySelectorAll('[data-chat2tasks="annotation"]')) node.remove();
const host = document.createElement('div');
host.id = 'chat2tasks-threads';
host.style.cssText = 'display:none;position:fixed;z-index:2147482000;';
const shadow = host.attachShadow({ mode: 'open' });
const toolbar = document.createElement('div');
toolbar.id = 'chat2tasks-modes';
toolbar.style.cssText = 'display:block;height:40px;min-height:40px;flex:0 0 40px;';
const toolbarShadow = toolbar.attachShadow({ mode: 'open' });
for (const root of [shadow, toolbarShadow]) {
  const style = document.createElement('style');
  style.textContent = styles + uiStyles;
  root.append(style);
}
document.body.append(host);
const mount = document.createElement('div');
mount.style.height = '100%';
shadow.append(mount);
const toolbarMount = document.createElement('div');
toolbarShadow.append(toolbarMount);
const annotations = new Map<HTMLElement, HTMLElement>();
let mode: Mode = 'chats',
  closeThreads = () => {},
  resize = () => {};
let covered: HTMLElement[] = [];
let sourceNavigation = false;
const previousInert = new Map<HTMLElement, boolean>();
function cover(active: boolean) {
  for (const el of covered) if (!active) el.inert = previousInert.get(el) ?? false;
  if (!active) {
    covered = [];
    previousInert.clear();
    return;
  }
  const side = document.querySelector<HTMLElement>('#side')?.parentElement;
  const main = document.querySelector<HTMLElement>('#main');
  for (const el of [side, main])
    if (el && !covered.includes(el)) {
      previousInert.set(el, el.inert);
      el.inert = true;
      covered.push(el);
    }
}
function position() {
  const side = document.querySelector<HTMLElement>('#side'),
    main = document.querySelector<HTMLElement>('#main');
  if (!side || !main) {
    if (mode === 'threads') closeThreads();
    return;
  }
  if (toolbar.parentElement !== side.parentElement || toolbar.nextElementSibling !== side)
    side.before(toolbar);
  if (mode === 'threads') {
    const rail = (side.parentElement ?? side).getBoundingClientRect(),
      pane = main.getBoundingClientRect();
    const left = Math.min(rail.left, pane.left),
      top = Math.min(rail.top, pane.top),
      right = Math.max(rail.right, pane.right),
      bottom = Math.max(rail.bottom, pane.bottom);
    host.style.left = left + 'px';
    host.style.top = top + 'px';
    host.style.width = right - left + 'px';
    host.style.height = bottom - top + 'px';
    host.style.setProperty('--thread-rail-width', rail.width + 'px');
    cover(true);
  }
}
function clearAnnotations() {
  for (const item of annotations.values()) item.remove();
  annotations.clear();
}
function placeAnnotations() {
  for (const [message, tag] of annotations) {
    const text = message.querySelector<HTMLElement>('.selectable-text, img');
    if (text)
      tag.style.paddingLeft =
        Math.max(8, text.getBoundingClientRect().left - message.getBoundingClientRect().left) +
        'px';
  }
}
const visibleMessages = () =>
  [...document.querySelectorAll<HTMLElement>('#main [data-id]')]
    .filter((el) => !!el.dataset.id)
    .slice(-500);
function currentTitle() {
  return (
    document.querySelector<HTMLElement>('#main header [dir="auto"]')?.textContent?.trim() ??
    document.querySelector<HTMLElement>('#main header span[title]')?.getAttribute('title') ??
    ''
  );
}
let lastSignature = '',
  lastFetch = 0,
  fetchVersion = 0;
async function annotate() {
  if (!host.isConnected) {
    dispose();
    return;
  }
  position();
  placeAnnotations();
  const elements = visibleMessages(),
    waIds = elements.flatMap((el) => (el.dataset.id ? [el.dataset.id] : []));
  const chatTitle = currentTitle(),
    signature = JSON.stringify([waIds, chatTitle]);
  if (signature === lastSignature && Date.now() - lastFetch < 14000) return;
  lastSignature = signature;
  lastFetch = Date.now();
  const version = ++fetchVersion;
  try {
    const data = await pageRequest({ kind: 'annotations', waIds, chatTitle }, AnnotationsSchema);
    if (version !== fetchVersion) return;
    const chosen = new Map<
      string,
      { element: HTMLElement; task: (typeof data.annotations)[number] }
    >();
    for (const el of elements)
      for (const task of data.annotations.filter((a) => a.waId === el.dataset.id))
        chosen.set(task.taskId, { element: el, task });
    const needed = new Map<HTMLElement, typeof data.annotations>();
    for (const { element, task } of chosen.values())
      needed.set(element, [...(needed.get(element) ?? []), task]);
    for (const [el, item] of annotations)
      if (!needed.has(el) || !el.contains(item)) {
        item.remove();
        annotations.delete(el);
      }
    for (const [el, tasks] of needed) {
      const signature = JSON.stringify(tasks),
        old = annotations.get(el);
      if (old?.dataset.signature === signature) continue;
      old?.remove();
      const tag = document.createElement('span');
      tag.dataset.chat2tasks = 'annotation';
      tag.dataset.signature = signature;
      tag.style.cssText = 'display:block;padding:1px 8px 3px;line-height:1.3;';
      const root = tag.attachShadow({ mode: 'open' }),
        style = document.createElement('style');
      style.textContent =
        'button{font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#59636b;background:none;border:0;padding:4px 2px;min-height:24px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}button:focus-visible{outline:2px solid #555;outline-offset:2px}';
      root.append(style);
      for (const task of tasks) {
        const button = document.createElement('button');
        button.textContent = task.reference;
        button.title = task.title + (task.done ? ' · Completed' : '');
        button.setAttribute('aria-label', `Open ${task.reference}: ${task.title}`);
        button.onclick = () => {
          void pageRequest({ kind: 'open-task', id: task.taskId }, Ok).catch((e) =>
            toast(e instanceof Error ? e.message : 'Open the companion to check its connection.'),
          );
        };
        root.append(button);
      }
      el.append(tag);
      annotations.set(el, tag);
    }
    placeAnnotations();
  } catch {
    if (version === fetchVersion) clearAnnotations();
  }
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  shadow.querySelector('.c-toast')?.remove();
  const element = document.createElement('div');
  element.className = 'c-toast';
  element.setAttribute('role', 'status');
  element.textContent = text;
  shadow.append(element);
  if (mode === 'chats') {
    host.style.display = 'block';
    host.style.pointerEvents = 'none';
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.remove();
    if (mode === 'chats') host.style.display = 'none';
  }, 6000);
}
function findOriginal(message: ThreadMessage) {
  const key = message.waMessageId ? whatsappMessageKey(message.waMessageId) : '';
  if (!key) return undefined;
  return visibleMessages().find((el) => whatsappMessageKey(el.dataset.id ?? '') === key);
}
function reveal(message: ThreadMessage) {
  const el = findOriginal(message);
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (!el.hasAttribute('tabindex')) {
    el.tabIndex = -1;
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  }
  el.focus({ preventScroll: true });
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    el.animate([{ outline: '2px solid #68756b' }, { outline: '2px solid transparent' }], {
      duration: 1800,
    });
  return true;
}
async function openOriginal(message: ThreadMessage, name: string, onClose: () => void) {
  sourceNavigation = true;
  onClose();
  await new Promise((done) => setTimeout(done, 0));
  cover(false);
  try {
    if (!message.waMessageId && currentTitle() === name) return;
    if (reveal(message)) return;
    const row = () =>
      [...document.querySelectorAll<HTMLElement>('#pane-side [role="row"]')].filter((el) =>
        [...el.querySelectorAll('[title]')].some((title) => title.getAttribute('title') === name),
      );
    let matches = row();
    if (matches.length !== 1) {
      const search = document.querySelector<HTMLInputElement>('#side input[role="textbox"]');
      if (search) {
        search.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(search, name);
        search.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 20; i++) {
          await new Promise((done) => setTimeout(done, 250));
          if (mode === 'threads') return;
          matches = row();
          if (matches.length === 1) break;
        }
      }
    }
    if (matches.length !== 1) {
      toast(`Choose ${name} in the WhatsApp chat list to reply.`);
      return;
    }
    matches[0]?.click();
    if (!message.waMessageId) return;
    for (let i = 0; i < 20; i++) {
      await new Promise((done) => setTimeout(done, 250));
      if (mode === 'threads') return;
      if (reveal(message)) return;
    }
    toast(`Find the source message in ${name}. Older messages may need to load first.`);
  } finally {
    sourceNavigation = false;
  }
}

function Modes({ value, onChange }: { value: Mode; onChange: (mode: Mode) => void }) {
  return (
    <nav className="c-mode" aria-label="Chat view">
      <button aria-pressed={value === 'chats'} onClick={() => onChange('chats')}>
        Chats
      </button>
      <button aria-pressed={value === 'threads'} onClick={() => onChange('threads')}>
        Threads
      </button>
      <span className="c-small">Wawa</span>
    </nav>
  );
}
function App() {
  const [view, setView] = useState<Mode>('chats');
  const [data, setData] = useState<ThreadSnapshot | null>(null),
    [error, setError] = useState('');
  const gate = useRef(new RefreshGate()),
    requested = useRef(false);
  const load = useCallback(async () => {
    const ticket = gate.current.start();
    try {
      const next = await pageRequest({ kind: 'threads' }, ThreadSnapshotSchema);
      if (!gate.current.accept(ticket)) return;
      setData(next);
      setError('');
      if (!requested.current && next.canOrganise) {
        await pageRequest({ kind: 'enable-threads' }, Ok);
        requested.current = true;
      }
    } catch (e) {
      if (gate.current.accept(ticket)) {
        clearAnnotations();
        setData(null);
        setError(e instanceof Error ? e.message : 'Could not load threads.');
      }
    }
  }, []);
  useEffect(() => {
    const wasOpen = mode === 'threads';
    mode = view;
    host.style.display = view === 'threads' ? 'block' : 'none';
    host.style.pointerEvents = 'auto';
    closeThreads = () => setView('chats');
    position();
    cover(view === 'threads');
    if (view !== 'threads') {
      if (wasOpen && !sourceNavigation)
        toolbarShadow.querySelector<HTMLButtonElement>('button:last-of-type')?.focus();
      return;
    }
    shadow.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    requested.current = false;
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => {
      clearInterval(timer);
      gate.current.invalidate();
    };
  }, [view, load]);
  async function move(input: ThreadMove) {
    gate.current.invalidate();
    const result = await pageRequest({ kind: 'move', input }, ThreadMoveResultSchema);
    await load();
    return result;
  }
  return (
    <>
      {createPortal(<Modes value={view} onChange={setView} />, toolbarMount)}
      {view === 'threads' && (
        <div
          className="c-smart"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setView('chats');
          }}
        >
          <Modes value={view} onChange={setView} />
          {error && (
            <div className="c-state" role="alert">
              <p>{error}</p>
              <button onClick={() => void load()}>Try again</button>
              <button
                onClick={() =>
                  void pageRequest({ kind: 'open-panel' }, Ok).catch((e) =>
                    toast(e instanceof Error ? e.message : 'Open the companion from your toolbar.'),
                  )
                }
              >
                Open companion
              </button>
            </div>
          )}
          {!data && !error && (
            <p className="c-state" role="status">
              Loading your threads…
            </p>
          )}
          {data && (
            <ThreadView
              data={data}
              onOrganise={async () => {
                await pageRequest({ kind: 'organise' }, Ok);
                await load();
              }}
              onMove={move}
              onOpenTask={(task) => {
                void pageRequest({ kind: 'open-task', id: task.id }, Ok).catch((e) =>
                  toast(e instanceof Error ? e.message : 'Could not open the task.'),
                );
              }}
              onOpenSource={(message) => {
                const name =
                  data.chats.find((c) => c.id === message.conversationId)?.name ??
                  'the original chat';
                void openOriginal(message, name, () => setView('chats'));
              }}
              onMedia={async (id) =>
                (await pageRequest({ kind: 'media', id }, ThreadMediaSchema)).dataUrl
              }
            />
          )}
        </div>
      )}
    </>
  );
}
resize = () => {
  position();
  placeAnnotations();
};
window.addEventListener('resize', resize);
let scanTimer: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver((records) => {
  if (!host.isConnected) {
    dispose();
    return;
  }
  for (const record of records)
    if (record.type === 'attributes' && record.target instanceof HTMLElement) {
      annotations.get(record.target)?.remove();
      annotations.delete(record.target);
      fetchVersion++;
    }
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => void annotate(), 250);
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['data-id'],
});
const poll = setInterval(() => void annotate(), 15000);
const app = createRoot(mount);
app.render(<App />);
let disposed = false;
function dispose() {
  if (disposed) return;
  disposed = true;
  fetchVersion++;
  observer.disconnect();
  clearInterval(poll);
  clearTimeout(scanTimer);
  clearTimeout(toastTimer);
  window.removeEventListener('resize', resize);
  cover(false);
  clearAnnotations();
  app.unmount();
  host.remove();
  toolbar.remove();
}
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) dispose();
});
void annotate();

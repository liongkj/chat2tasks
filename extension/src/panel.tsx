import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  ExternalLink,
  Link2,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import { z } from 'zod';
import '@fontsource-variable/dm-sans';
import {
  BackendUrlSchema,
  CaptureDraftSchema,
  CaptureResultSchema,
  CompanionStateSchema,
  CompanionTaskSchema,
  ConnectionSchema,
  type CaptureDraft,
  type CompanionState,
  type Connection,
} from '../../src/shared/companion.js';
import type { Task } from '../../src/shared/schema.js';
import { ApiError, OkSchema, pair, request } from './api.js';
import './style.css';

type Session =
  { kind: 'loading' } | { kind: 'unpaired' } | { kind: 'paired'; connection: Connection };
const message = (error: unknown) =>
  error instanceof TypeError
    ? 'Cannot reach your server. Check its address and your network connection.'
    : error instanceof Error
      ? error.message
      : 'Something went wrong. Try again.';
function App() {
  const [session, setSession] = useState<Session>({ kind: 'loading' });
  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:2786'),
    [code, setCode] = useState(''),
    [name, setName] = useState('My Chrome browser');
  const [state, setState] = useState<CompanionState | null>(null),
    [detail, setDetail] = useState<z.infer<typeof CompanionTaskSchema> | null>(null);
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'tasks' | 'chats' | 'capture'>('tasks');
  const [draft, setDraft] = useState<CaptureDraft | null>(null),
    [captureChat, setCaptureChat] = useState('');
  const [chatFilter, setChatFilter] = useState(''),
    [showDone, setShowDone] = useState(false),
    [search, setSearch] = useState('');
  const refreshing = useRef(false);
  const connection = session.kind === 'paired' ? session.connection : null;
  const unpair = useCallback(async () => {
    await chrome.storage.local.remove('connection');
    setSession({ kind: 'unpaired' });
    setState(null);
    setDetail(null);
  }, []);
  useEffect(() => {
    void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    void chrome.storage.local.get(['connection', 'serverUrl']).then((values) => {
      const saved = ConnectionSchema.safeParse(values.connection);
      if (saved.success) {
        setServerUrl(saved.data.serverUrl);
        setSession({ kind: 'paired', connection: saved.data });
      } else {
        if (typeof values.serverUrl === 'string') setServerUrl(values.serverUrl);
        setSession({ kind: 'unpaired' });
      }
    });
    function loadDraft(value: unknown) {
      const parsed = CaptureDraftSchema.safeParse(value);
      if (parsed.success) {
        setDraft(parsed.data);
        setDetail(null);
        setTab('capture');
      }
    }
    void chrome.storage.session.get(['captureDraft', 'captureError']).then((values) => {
      loadDraft(values.captureDraft);
      if (typeof values.captureError === 'string') setNotice(values.captureError);
    });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (changes.captureDraft?.newValue) loadDraft(changes.captureDraft.newValue);
      if (typeof changes.captureError?.newValue === 'string')
        setNotice(changes.captureError.newValue);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  const refresh = useCallback(async () => {
    if (!connection || refreshing.current) return;
    refreshing.current = true;
    try {
      setState(await request(connection, 'state', CompanionStateSchema));
    } catch (error) {
      setNotice(message(error));
      if (error instanceof ApiError && error.status === 401) await unpair();
    } finally {
      refreshing.current = false;
    }
  }, [connection, unpair]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const url = BackendUrlSchema.parse(serverUrl),
        parsedUrl = new URL(url);
      const granted = await chrome.permissions.request({
        origins: [`${parsedUrl.protocol}//${parsedUrl.hostname}/*`],
      });
      if (!granted) throw new Error('Allow access to your Chat2Tasks server to pair this browser.');
      const result = await pair(url, code, name),
        next = { serverUrl: url, ...result };
      await chrome.storage.local.set({ connection: next, serverUrl: url });
      setSession({ kind: 'paired', connection: next });
      setCode('');
      setNotice('Connected to your workspace.');
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await work();
    } catch (error) {
      setNotice(message(error));
      if (error instanceof ApiError && error.status === 401) await unpair();
    } finally {
      setBusy(false);
    }
  }
  async function tick(task: Task) {
    if (!connection) return;
    await request(connection, 'tick', OkSchema, { id: task.id, done: !task.done });
    setDetail((previous) =>
      previous?.task.id === task.id
        ? { ...previous, task: { ...previous.task, done: !task.done } }
        : previous,
    );
    await refresh();
  }
  async function disconnect() {
    if (!connection) return;
    try {
      await request(connection, 'disconnect', OkSchema, {});
      setNotice('Browser disconnected.');
    } catch {
      setNotice(
        'Removed from this browser. Revoke its device in workspace Settings when the server is reachable.',
      );
    }
    await unpair();
  }
  const openWorkspace = () => {
    if (connection) void chrome.tabs.create({ url: connection.serverUrl });
  };
  const tasks =
    state?.tasks.filter(
      (t) =>
        t.done === showDone &&
        (!chatFilter || t.chatIds.includes(chatFilter)) &&
        (t.title + ' ' + t.scope).toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const destinationChat =
    state?.chats.find((chat) => chat.id === captureChat && chat.enabled)?.id ??
    state?.chats.find((chat) => chat.enabled)?.id ??
    '';
  return (
    <div className="panel">
      <header>
        <span className="brand">
          <span className="brand-icon">
            <MessageSquare size={19} />
            <Check size={10} />
          </span>
          <span>
            chat2tasks<small>WhatsApp companion</small>
          </span>
        </span>
        {connection && (
          <button className="icon" title="Open full workspace" onClick={openWorkspace}>
            <ExternalLink size={17} />
          </button>
        )}
      </header>
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="icon" aria-label="Dismiss notification" onClick={() => setNotice('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {session.kind === 'loading' ? (
        <div className="empty">
          <LoaderCircle className="spin" />
          Opening your workspace…
        </div>
      ) : session.kind === 'unpaired' ? (
        <main className="setup">
          <div className="setup-art">
            <Link2 size={25} />
          </div>
          <div className="eyebrow">YOUR WORK, CLOSE BY</div>
          <h1>
            A little less
            <br />
            to switch between.
          </h1>
          <p>Keep tasks beside WhatsApp Web. Connect this browser to your own Chat2Tasks server.</p>
          <form onSubmit={(event) => void connect(event)}>
            <label>
              Server address
              <input
                aria-label="Server address"
                type="url"
                required
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://tasks.example.com"
              />
            </label>
            <label>
              Pairing code
              <input
                aria-label="Pairing code"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={40}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Create a code in workspace Settings"
              />
            </label>
            <label>
              Browser name
              <input
                aria-label="Browser name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button className="primary" disabled={busy} type="submit">
              {busy ? <LoaderCircle className="spin" size={15} /> : <Link2 size={15} />} Connect
              workspace
            </button>
          </form>
          <div className="hint">
            <ShieldCheck size={16} />
            <p>
              In your full workspace, open <strong>Settings → Chrome companion</strong> to create a
              one-time code. Your model keys stay on your server.
            </p>
          </div>
        </main>
      ) : (
        <>
          <nav aria-label="Companion views">
            {(['tasks', 'chats', 'capture'] satisfies ('tasks' | 'chats' | 'capture')[]).map(
              (item) => (
                <button
                  key={item}
                  className={tab === item && !detail ? 'active' : ''}
                  onClick={() => {
                    setTab(item);
                    setDetail(null);
                  }}
                >
                  {item === 'tasks' ? (
                    'My tasks'
                  ) : item === 'chats' ? (
                    'Conversations'
                  ) : (
                    <>Capture{draft && <span className="dot" />}</>
                  )}
                </button>
              ),
            )}
          </nav>
          {detail ? (
            <main className="detail">
              <button className="text-button" onClick={() => setDetail(null)}>
                <ArrowLeft size={14} /> Back to tasks
              </button>
              <span className="scope">{detail.task.scope}</span>
              <h1>{detail.task.title}</h1>
              <p>{detail.task.note}</p>
              <h2>Next steps</h2>
              <ol>
                {detail.task.action_steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <h2>You’re done when</h2>
              <ul className="criteria">
                {detail.task.done_when.map((step) => (
                  <li key={step}>
                    <CheckCheck size={14} />
                    {step}
                  </li>
                ))}
              </ul>
              <Note
                key={detail.task.id}
                task={detail.task}
                busy={busy}
                onSave={(remark) =>
                  action(async () => {
                    if (connection) {
                      await request(connection, 'note', OkSchema, { id: detail.task.id, remark });
                      await refresh();
                      setNotice('Note saved.');
                    }
                  })
                }
              />
              <button
                className="primary"
                disabled={busy}
                onClick={() => void action(() => tick(detail.task))}
              >
                <Check size={15} />
                {detail.task.done ? 'Mark as to do' : 'Mark complete'}
              </button>
              <h2>Original conversation</h2>
              {detail.messages.map((m) => (
                <article className="source" key={m.id}>
                  <small>
                    {m.browser_source
                      ? 'Captured selection'
                      : m.direction === 'outgoing'
                        ? 'You'
                        : 'Incoming message'}{' '}
                    · {new Date(m.timestamp * 1000).toLocaleDateString()}
                  </small>
                  <p>{m.body || `[${m.type}]`}</p>
                  {m.type === 'image' && (
                    <button className="text-button" onClick={openWorkspace}>
                      View image in workspace <ArrowUpRight size={13} />
                    </button>
                  )}
                </article>
              ))}
            </main>
          ) : tab === 'tasks' ? (
            <main className="task-view">
              <div className="view-heading">
                <div>
                  <div className="eyebrow">A CLEARER NEXT STEP</div>
                  <h1>Your next moves.</h1>
                </div>
                <button className="icon" aria-label="Refresh tasks" onClick={() => void refresh()}>
                  <RefreshCw size={16} />
                </button>
              </div>
              <label className="sr-only" htmlFor="conversation-filter">
                Filter by conversation
              </label>
              <select
                id="conversation-filter"
                value={chatFilter}
                onChange={(event) => setChatFilter(event.target.value)}
              >
                <option value="">All conversations</option>
                {state?.chats.map((chat) => (
                  <option key={chat.id} value={chat.id}>
                    {chat.name}
                    {chat.enabled ? '' : ' · paused'}
                  </option>
                ))}
              </select>
              <div className="task-tabs">
                <button className={!showDone ? 'active' : ''} onClick={() => setShowDone(false)}>
                  To do <span>{state?.tasks.filter((t) => !t.done).length ?? 0}</span>
                </button>
                <button className={showDone ? 'active' : ''} onClick={() => setShowDone(true)}>
                  Completed
                </button>
              </div>
              <input
                className="search"
                aria-label="Search tasks"
                placeholder="Find a task…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {!state ? (
                <div className="empty">Connecting to your workspace…</div>
              ) : !tasks.length ? (
                <div className="empty">
                  <CheckCheck size={28} />
                  <h2>{showDone ? 'A place for finished work.' : 'A little breathing room.'}</h2>
                  <p>
                    {search
                      ? 'No tasks match your search.'
                      : 'Tasks from your followed conversations appear here.'}
                  </p>
                </div>
              ) : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <input
                        aria-label={`Complete: ${task.title}`}
                        type="checkbox"
                        checked={task.done}
                        disabled={busy}
                        onChange={() => void action(() => tick(task))}
                      />
                      <button
                        className="task-open"
                        onClick={() =>
                          void action(async () => {
                            if (connection)
                              setDetail(
                                await request(
                                  connection,
                                  'tasks/' + encodeURIComponent(task.id),
                                  CompanionTaskSchema,
                                ),
                              );
                          })
                        }
                      >
                        <strong>{task.title}</strong>
                        <span>{task.scope}</span>
                        {task.triage_state === 'needs_info' && <small>Needs a detail</small>}
                      </button>
                      {task.priority === 'high' && (
                        <span className="priority" title="High priority">
                          ↑
                        </span>
                      )}
                      <ChevronRight size={14} />
                    </li>
                  ))}
                </ul>
              )}
            </main>
          ) : tab === 'chats' ? (
            <main className="chats">
              <div className="eyebrow">ONLY THE CHATS YOU CHOOSE</div>
              <h1>
                Keep the right
                <br />
                conversations close.
              </h1>
              <p>Pausing stops new analysis. Existing tasks and notes stay available.</p>
              {state?.chats.map((chat) => (
                <div className="chat" key={chat.id}>
                  <span className="avatar">{chat.name.slice(0, 1)}</span>
                  <div>
                    <strong>{chat.name}</strong>
                    <small>{chat.enabled ? 'Following' : 'Paused'}</small>
                  </div>
                  <button
                    className={'toggle ' + (chat.enabled ? 'on' : '')}
                    role="switch"
                    aria-checked={chat.enabled}
                    aria-label={`Activate ${chat.name}`}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        if (connection) {
                          await request(connection, 'activation', OkSchema, {
                            id: chat.id,
                            enabled: !chat.enabled,
                          });
                          await refresh();
                        }
                      })
                    }
                  >
                    <span />
                  </button>
                </div>
              ))}
              {!state?.chats.length && (
                <div className="empty">Add your first conversation in the full workspace.</div>
              )}
              <button className="secondary" onClick={openWorkspace}>
                <Settings2 size={15} /> Manage conversations
              </button>
            </main>
          ) : (
            <main className="capture">
              <div className="eyebrow">FROM CHAT TO NEXT STEP</div>
              <h1>A thought worth keeping.</h1>
              <p>
                Select text in WhatsApp Web, right-click, and choose{' '}
                <strong>Capture selection in Chat2Tasks</strong>. Review it here before saving.
              </p>
              {draft ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      if (!connection) return;
                      const result = await request(connection, 'capture', CaptureResultSchema, {
                        ...draft,
                        chatId: destinationChat,
                      });
                      await chrome.storage.session.remove('captureDraft');
                      setDraft(null);
                      await refresh();
                      setNotice(
                        result.queued
                          ? 'Selection saved. Your server will debounce and decide when to analyze it.'
                          : 'Selection saved. Choose Run now when you’re ready to analyze.',
                      );
                    });
                  }}
                >
                  <label>
                    Save to conversation
                    <select
                      aria-label="Save to conversation"
                      required
                      value={destinationChat}
                      onChange={(event) => setCaptureChat(event.target.value)}
                    >
                      <option value="" disabled>
                        Choose an active conversation
                      </option>
                      {state?.chats
                        .filter((c) => c.enabled)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Selected text
                    <textarea
                      aria-label="Selected text"
                      value={draft.text}
                      rows={8}
                      required
                      maxLength={16000}
                      onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                    />
                  </label>
                  <small className="source-label">From {draft.title} · WhatsApp Web</small>
                  <button
                    className="primary"
                    disabled={busy || !state?.chats.some((c) => c.enabled)}
                  >
                    <Check size={15} /> Save selection
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      void chrome.storage.session.remove('captureDraft');
                      setDraft(null);
                    }}
                  >
                    Discard selection
                  </button>
                </form>
              ) : (
                <div className="empty">
                  <MessageSquare size={30} />
                  <h2>You choose what to capture.</h2>
                  <p>
                    No background scraping. Selected text reaches your server only after you save
                    it.
                  </p>
                  <button
                    className="secondary"
                    onClick={() => void chrome.tabs.create({ url: 'https://web.whatsapp.com/' })}
                  >
                    Open WhatsApp Web <ArrowUpRight size={14} />
                  </button>
                </div>
              )}
            </main>
          )}
          <footer>
            <div className="status">
              <span className={state?.status.syncing ? 'dot pulse' : 'dot green'} />
              <span>
                {state?.status.error ?? state?.status.phase ?? 'Connecting…'}
                <small>
                  {state?.analysisMode === 'manual'
                    ? 'Manual analysis'
                    : `Automatic · ${state?.quietSeconds ?? 45}s quiet period`}
                </small>
              </span>
              <button
                className="run"
                disabled={busy || !state?.chats.some((c) => c.enabled) || state.status.syncing}
                onClick={() =>
                  void action(async () => {
                    if (connection) {
                      await request(connection, 'run', OkSchema, {});
                      await refresh();
                      setNotice('Task analysis requested.');
                    }
                  })
                }
              >
                <Zap size={13} /> Run now
              </button>
            </div>
            <div className="footer-links">
              <button onClick={openWorkspace}>
                Open workspace <ArrowUpRight size={12} />
              </button>
              <button onClick={() => void action(disconnect)}>
                <Unplug size={12} /> Disconnect
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
function Note({
  task,
  busy,
  onSave,
}: {
  task: Task;
  busy: boolean;
  onSave: (remark: string) => Promise<void>;
}) {
  const [note, setNote] = useState(task.own_remark ?? '');
  return (
    <div className="note">
      <label>
        Your note
        <textarea
          aria-label="Your note"
          value={note}
          maxLength={4000}
          rows={3}
          placeholder="A little context for later…"
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button className="text-button" disabled={busy} onClick={() => void onSave(note)}>
        Save note <Check size={12} />
      </button>
    </div>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);

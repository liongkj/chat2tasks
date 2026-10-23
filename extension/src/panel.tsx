import { useInputModality } from '../../src/shared/useInputModality.js';
import { Menu } from '@base-ui/react/menu';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
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
  Circle,
  CircleCheck,
  ChevronUp,
  MoreHorizontal,
  SlidersHorizontal,
  X,
  Zap,
} from 'lucide-react';
import { z } from 'zod';
import '../../src/shared/theme.css';
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
  useInputModality();
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
  const [showOptions, setShowOptions] = useState(false),
    [showFilters, setShowFilters] = useState(false);
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
  const openConversation = (taskId: string) => {
    if (!connection) return;
    const url = new URL(connection.serverUrl);
    url.searchParams.set('task', taskId);
    url.searchParams.set('context', 'conversation');
    void chrome.tabs.create({ url: url.href });
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
          <h1>Connect your workspace</h1>
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
          {tab === 'tasks' && (
            <div className="view-heading">
              <h1>{showDone ? 'Completed' : 'My Tasks'}</h1>
              <button
                className="icon"
                aria-label="Filter tasks"
                aria-expanded={showFilters}
                onClick={() => setShowFilters(!showFilters)}
              >
                <SlidersHorizontal size={18} />
              </button>
            </div>
          )}
          <nav aria-label="Companion views">
            {(['tasks', 'chats', 'capture'] satisfies ('tasks' | 'chats' | 'capture')[]).map(
              (item) => (
                <button
                  key={item}
                  className={tab === item ? 'active' : ''}
                  onClick={() => {
                    setTab(item);
                    setDetail(null);
                  }}
                >
                  {item === 'tasks' ? (
                    'Tasks'
                  ) : item === 'chats' ? (
                    'Conversations'
                  ) : (
                    <>Capture{draft && <span className="dot" />}</>
                  )}
                </button>
              ),
            )}
          </nav>
          {tab === 'tasks' ? (
            <main className="task-view">
              {showFilters && (
                <div className="filters">
                  {' '}
                  <div className="task-tabs">
                    <button
                      className={!showDone ? 'active' : ''}
                      onClick={() => setShowDone(false)}
                    >
                      To do <span>{state?.tasks.filter((t) => !t.done).length ?? 0}</span>
                    </button>
                    <button className={showDone ? 'active' : ''} onClick={() => setShowDone(true)}>
                      Completed
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
                  <input
                    className="search"
                    aria-label="Search tasks"
                    placeholder="Find a task…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              )}
              {!state ? (
                <div className="empty">Connecting to your workspace…</div>
              ) : !tasks.length ? (
                <div className="empty">
                  <CheckCheck size={28} />
                  <h2>{showDone ? 'No completed tasks yet' : 'You’re all caught up'}</h2>
                  <p>
                    {search
                      ? 'No tasks match your search.'
                      : 'Tasks from your followed conversations appear here.'}
                  </p>
                </div>
              ) : (
                <ul className="task-list">
                  {tasks.map((task) => (
                    <li key={task.id} className={detail?.task.id === task.id ? 'expanded' : ''}>
                      <div className="task-row">
                        <button
                          className="completion"
                          aria-label={`${task.done ? 'Reopen' : 'Complete'}: ${task.title}`}
                          aria-pressed={task.done}
                          disabled={busy}
                          onClick={() => void action(() => tick(task))}
                        >
                          {task.done ? <CircleCheck size={25} /> : <Circle size={25} />}
                        </button>
                        <button
                          className="task-open"
                          aria-expanded={detail?.task.id === task.id}
                          onClick={() =>
                            void action(async () => {
                              if (detail?.task.id === task.id) {
                                setDetail(null);
                                return;
                              }
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
                          <span>
                            {state?.chats.find((chat) => task.chatIds.includes(chat.id))?.name ??
                              task.scope}
                          </span>
                          {task.triage_state === 'needs_info' && <small>Needs a detail</small>}
                        </button>
                        {detail?.task.id === task.id ? (
                          <button
                            className="icon"
                            aria-label="Collapse task"
                            onClick={() => setDetail(null)}
                          >
                            <ChevronUp size={16} />
                          </button>
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </div>
                      {detail?.task.id === task.id && (
                        <div className="task-expansion">
                          <h2>Next steps</h2>
                          <ol className="steps">
                            {detail.task.action_steps.map((step) => (
                              <li key={step}>{step}</li>
                            ))}
                          </ol>
                          {detail.messages.length > 0 && (
                            <section className="source-preview">
                              <h2>From the conversation</h2>
                              <blockquote>
                                <p>{detail.messages[0]?.body || 'Image attachment'}</p>
                                <cite>
                                  {new Date(
                                    (detail.messages[0]?.timestamp ?? 0) * 1000,
                                  ).toLocaleString()}
                                </cite>
                              </blockquote>
                            </section>
                          )}
                          <button className="text-button" onClick={() => openConversation(task.id)}>
                            <ArrowUpRight size={16} /> View conversation in workspace
                          </button>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => void action(() => tick(detail.task))}
                          >
                            {detail.task.done ? 'Mark as to do' : 'Mark Complete'}
                          </button>
                          <details>
                            <summary>Notes &amp; details</summary>
                            <Note
                              key={detail.task.id}
                              task={detail.task}
                              busy={busy}
                              onSave={(remark) =>
                                action(async () => {
                                  if (connection) {
                                    await request(connection, 'note', OkSchema, {
                                      id: detail.task.id,
                                      remark,
                                    });
                                    await refresh();
                                    setNotice('Note saved.');
                                  }
                                })
                              }
                            />

                            <p>{detail.task.note}</p>
                            <h2>You’re done when</h2>
                            <ul className="criteria">
                              {detail.task.done_when.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ul>
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
                                  <button
                                    className="text-button"
                                    onClick={() => openConversation(task.id)}
                                  >
                                    View image in workspace <ArrowUpRight size={14} />
                                  </button>
                                )}
                              </article>
                            ))}
                          </details>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </main>
          ) : tab === 'chats' ? (
            <main className="chats">
              <h1>Conversations</h1>
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
              <h1>Capture a message</h1>
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
            <Menu.Root open={showOptions} onOpenChange={setShowOptions}>
              <div className="status">
                <span className={state?.status.error ? 'dot warning' : 'dot green'} />
                <span>
                  {state?.status.error
                    ? 'Needs attention'
                    : state?.status.syncing
                      ? 'Updating tasks…'
                      : state
                        ? 'Connected to workspace'
                        : 'Connecting…'}
                </span>
                <Menu.Trigger className="icon" aria-label="More options">
                  <MoreHorizontal size={21} />
                </Menu.Trigger>
              </div>
              <Menu.Portal>
                <Menu.Positioner className="menu-positioner" side="top" align="end" sideOffset={8}>
                  <Menu.Popup className="options-menu">
                    <Menu.Item
                      onClick={() => {
                        setShowDone(!showDone);
                        setTab('tasks');
                        setDetail(null);
                        setShowOptions(false);
                      }}
                    >
                      <CheckCheck size={16} /> {showDone ? 'Show to do' : 'Show completed'}
                    </Menu.Item>
                    <Menu.Item
                      aria-label="Refresh tasks"
                      onClick={() => {
                        void refresh();
                        setShowOptions(false);
                      }}
                    >
                      <RefreshCw size={16} /> Refresh tasks
                    </Menu.Item>
                    {state?.status.error && <p role="alert">{state.status.error}</p>}
                    <Menu.Item
                      disabled={
                        busy || !state?.chats.some((c) => c.enabled) || state.status.syncing
                      }
                      onClick={() =>
                        void action(async () => {
                          if (connection) {
                            await request(connection, 'run', OkSchema, {});
                            await refresh();
                            setNotice('Task analysis requested.');
                            setShowOptions(false);
                          }
                        })
                      }
                    >
                      <Zap size={16} /> Find tasks now
                    </Menu.Item>
                    <Menu.Item onClick={openWorkspace}>
                      <ArrowUpRight size={16} /> Open workspace
                    </Menu.Item>
                    <Menu.Item onClick={() => void action(disconnect)}>
                      <Unplug size={16} /> Disconnect
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
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

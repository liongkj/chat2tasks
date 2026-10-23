import { useInputModality } from '../shared/useInputModality.js';
import { Menu } from '@base-ui/react/menu';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Command,
  Copy,
  FileText,
  Inbox,
  LoaderCircle,
  Menu as MenuIcon,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
  TriangleAlert,
  Activity,
} from 'lucide-react';
import { z } from 'zod';
import {
  PublicSettingsSchema,
  SnapshotSchema,
  type Snapshot,
  type Task,
  type Message,
  type PublicSettings,
} from '../shared/schema.js';
import { api, download, OkSchema, time } from './api.js';
import { SettingsPanel } from './Settings.js';

type View = 'tasks' | 'chats' | 'models' | 'activity';
const empty: Snapshot = {
  demo: false,
  tasks: [],
  messages: [],
  questions: [],
  status: { syncing: false, phase: 'Connecting', pending: 0, error: null, debouncing: false },
  usage: { calls: 0, totalTokens: 0, model: '' },
};
const stateLabel = {
  ready: 'Ready to start',
  waiting: 'Waiting',
  needs_info: 'Needs a detail',
  reported_done: 'Ready to verify',
};

export function App() {
  useInputModality();
  const [data, setData] = useState(empty),
    [config, setConfig] = useState<PublicSettings | null>(null);
  const [view, setView] = useState<View>('tasks'),
    [filter, setFilter] = useState<'open' | 'all' | 'done'>('open');
  const [query, setQuery] = useState(''),
    [chat, setChat] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(() =>
      new URLSearchParams(window.location.search).get('task'),
    );
  const [notice, setNotice] = useState(''),
    [online, setOnline] = useState(true),
    [mobileMenu, setMobileMenu] = useState(false),
    [showMenu, setShowMenu] = useState(false);
  const search = useRef<HTMLInputElement>(null),
    file = useRef<HTMLInputElement>(null);
  const initialSelection = useRef(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api('state', SnapshotSchema));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);
  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api('settings', PublicSettingsSchema));
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshConfig();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, refreshConfig]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setView('tasks');
        search.current?.focus();
      }
      if (event.key === 'Escape') {
        setSelected(null);
        setMobileMenu(false);
        setShowMenu(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  const navigate = (next: View) => {
    setView(next);
    setMobileMenu(false);
    setShowMenu(false);
  };
  const settings = config?.settings;
  const currentChat = settings?.chats.find((c) => c.id === chat);
  const sourceIds = new Set(
    data.messages
      .filter(
        (m) =>
          !currentChat ||
          (m.chatId === currentChat.chatId && m.sessionId === currentChat.sessionId),
      )
      .map((m) => m.id),
  );
  const scoped = data.tasks.filter(
    (t) => !currentChat || t.source_ids.some((id) => sourceIds.has(id)),
  );
  const visible = scoped
    .filter(
      (t) =>
        (filter === 'all' || t.done === (filter === 'done')) &&
        `${t.title} ${t.scope} ${t.note}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.priority === 'high') - Number(a.priority === 'high') ||
        b.updated - a.updated,
    );
  const selectedTask = data.tasks.find((t) => t.id === selected);
  useEffect(() => {
    if (initialSelection.current || !visible.length) return;
    initialSelection.current = true;
    if (
      !data.tasks.some((task) => task.id === selected) &&
      window.matchMedia('(min-width: 1024px)').matches
    )
      setSelected(visible[0]?.id ?? null);
  }, [visible, selected, data.tasks]);
  async function tick(task: Task) {
    try {
      await api('tick', OkSchema, { id: task.id, done: !task.done });
      await refresh();
      setNotice(task.done ? 'Moved back to your tasks' : 'One less thing. Task completed.');
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  async function sync() {
    try {
      await api('sync', OkSchema, {});
      setNotice('Running task analysis now…');
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  const title =
    view === 'tasks'
      ? (currentChat?.name ?? (filter === 'done' ? 'Completed' : 'My Tasks'))
      : view === 'chats'
        ? 'Conversations'
        : view === 'models'
          ? 'Models & API keys'
          : 'Activity';
  return (
    <div className={`app ${mobileMenu ? 'menu-open' : ''}`}>
      {mobileMenu && (
        <button
          className="menu-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => {
            setChat(null);
            navigate('tasks');
          }}
        >
          <span>chat2tasks</span>
        </button>
        <div className="search-shortcut">
          <Search size={15} />
          <input
            ref={search}
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              navigate('tasks');
            }}
          />
          <kbd>⌘ K</kbd>
        </div>
        <nav aria-label="Workspace">
          <button
            className={
              view === 'tasks' && !chat && filter !== 'done' ? 'nav-item active' : 'nav-item'
            }
            onClick={() => {
              setChat(null);
              setFilter('open');
              setSelected(null);
              navigate('tasks');
            }}
          >
            <Inbox size={17} />
            <span>My Tasks</span>
            <span className="nav-count">{data.tasks.filter((t) => !t.done).length}</span>
          </button>
          <button
            className={view === 'chats' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('chats')}
          >
            <MessageSquare size={17} />
            <span>Conversations</span>
            <span className="nav-count">{settings?.chats.length ?? 0}</span>
          </button>
          <button
            className={view === 'tasks' && filter === 'done' ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setChat(null);
              setFilter('done');
              setSelected(null);
              navigate('tasks');
            }}
          >
            <CircleCheck size={19} />
            <span>Completed</span>
            <span className="nav-count">{data.tasks.filter((t) => t.done).length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={view === 'activity' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('activity')}
          >
            <Activity size={18} />
            <span>Activity</span>
            {data.status.syncing && <span className="live-dot" />}
          </button>
          <button
            className={view === 'models' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('models')}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(true)}
            >
              <MenuIcon size={18} />
            </button>
            <span className="workspace-crumb">{data.demo ? 'Sample workspace' : 'Workspace'}</span>
            <ChevronRight size={12} />
            <span>{title}</span>
          </div>
          <div className="topbar-status">
            <span className={`live-dot ${!online || data.status.error ? 'warning' : ''}`} />
            <span>
              {!online
                ? 'Reconnecting…'
                : data.status.syncing
                  ? 'Working quietly…'
                  : data.status.error
                    ? 'Needs attention'
                    : data.demo
                      ? 'Sample workspace'
                      : 'Connected'}
            </span>
            <button
              className="avatar"
              aria-label="Open workspace settings"
              onClick={() => navigate('models')}
            >
              Me
            </button>
          </div>
        </header>
        {view === 'chats' || view === 'models' ? (
          config && (
            <SettingsPanel
              key={view}
              tab={view}
              config={config}
              onSave={(c) => {
                setConfig(c);
                void refresh();
              }}
              notify={setNotice}
            />
          )
        ) : view === 'activity' ? (
          <ActivityView data={data} onSync={() => void sync()} />
        ) : (
          <>
            <div className="task-layout">
              <section className="task-column">
                <div className="page-heading">
                  <h1>{currentChat?.name ?? (filter === 'done' ? 'Completed' : 'My Tasks')}</h1>
                  <p>
                    {new Intl.DateTimeFormat(undefined, {
                      weekday: 'long',
                      day: 'numeric',
                      month: 'long',
                    }).format(new Date())}
                  </p>
                </div>
                <div className="task-toolbar">
                  <div className="tabs" role="tablist" aria-label="Task status">
                    {(
                      [
                        ['open', 'To do'],
                        ['done', 'Completed'],
                      ] satisfies [typeof filter, string][]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        role="tab"
                        aria-selected={filter === value}
                        className={filter === value ? 'selected' : ''}
                        onClick={() => {
                          setFilter(value);
                          setSelected(null);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="task-toolbar-end">
                    <select
                      aria-label="Filter by conversation"
                      value={chat ?? ''}
                      onChange={(event) => {
                        setChat(event.target.value || null);
                        setSelected(null);
                      }}
                    >
                      <option value="">All conversations</option>
                      {settings?.chats.map((conversation) => (
                        <option key={conversation.id} value={conversation.id}>
                          {conversation.name}
                        </option>
                      ))}
                    </select>
                    <Menu.Root open={showMenu} onOpenChange={setShowMenu}>
                      <Menu.Trigger className="icon-btn" aria-label="More task actions">
                        <MoreHorizontal size={18} />
                      </Menu.Trigger>
                      <Menu.Portal>
                        <Menu.Positioner className="menu-positioner" sideOffset={6} align="end">
                          <Menu.Popup className="popover">
                            <Menu.Item
                              disabled={data.status.syncing}
                              onClick={() => {
                                void sync();
                                setShowMenu(false);
                              }}
                            >
                              <Zap size={16} /> Find tasks now
                            </Menu.Item>
                            <Menu.Item
                              onClick={() => {
                                setFilter('all');
                                setShowMenu(false);
                              }}
                            >
                              Show all tasks
                            </Menu.Item>
                            <Menu.Item
                              onClick={() => {
                                download('chat2tasks-export.json', JSON.stringify(data, null, 2));
                                setShowMenu(false);
                              }}
                            >
                              <ArrowDownToLine size={14} /> Export workspace
                            </Menu.Item>
                            <Menu.Item
                              onClick={() => {
                                file.current?.click();
                                setShowMenu(false);
                              }}
                            >
                              <FileText size={14} /> Import task ticks
                            </Menu.Item>
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.Root>
                  </div>
                </div>
                {data.status.error && (
                  <div className="inline-alert">
                    <TriangleAlert size={15} />
                    <div>
                      <strong>Sync needs a moment</strong>
                      <p>{data.status.error}</p>
                      {data.status.retry_at && (
                        <small>Will retry automatically · {time(data.status.retry_at)}</small>
                      )}
                    </div>
                    <button className="text-button" onClick={() => navigate('models')}>
                      Settings
                    </button>
                  </div>
                )}
                {data.questions.map((q) => (
                  <div className="question-card" key={q.id}>
                    <span className="label purple">A quick clarification</span>
                    <h3>{q.question}</h3>
                    <p>“{data.messages.find((m) => m.id === q.message_id)?.body}”</p>
                    <div className="form-inline">
                      <select
                        aria-label="Choose the completed task"
                        defaultValue=""
                        onChange={async (e) => {
                          if (!e.target.value) return;
                          try {
                            await api('resolve', OkSchema, { id: q.id, task_id: e.target.value });
                            await refresh();
                          } catch (err) {
                            setNotice(errorMessage(err));
                          }
                        }}
                      >
                        <option value="" disabled>
                          Choose the completed task…
                        </option>
                        {data.tasks
                          .filter((t) => {
                            const m = data.messages.find((m) => m.id === q.message_id);
                            return (
                              m &&
                              t.source_ids.some((id) =>
                                data.messages.some(
                                  (source) =>
                                    source.id === id &&
                                    source.chatId === m.chatId &&
                                    source.sessionId === m.sessionId,
                                ),
                              )
                            );
                          })
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.title}
                            </option>
                          ))}
                      </select>
                      <button
                        className="text-button"
                        onClick={async () => {
                          try {
                            await api('resolve', OkSchema, { id: q.id, task_id: null });
                            await refresh();
                          } catch (e) {
                            setNotice(errorMessage(e));
                          }
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
                <div className="task-list">
                  {!data.tasks.length ? (
                    <div className="onboarding">
                      <div className="empty-art">
                        <MessageSquare size={28} />
                        <span>
                          <Check size={14} />
                        </span>
                      </div>
                      <h2>Good conversations lead somewhere.</h2>
                      <p>
                        Connect a WhatsApp chat. We’ll find the follow-ups and keep the original
                        context one click away.
                      </p>
                      <button className="button primary" onClick={() => navigate('chats')}>
                        <Plus size={15} /> Connect your first chat
                      </button>
                      <small>
                        <ShieldCheck size={12} />
                        Nothing is sent back to WhatsApp.
                      </small>
                    </div>
                  ) : !visible.length ? (
                    <div className="empty-state">
                      <CheckCheck size={30} />
                      <h3>{query ? 'No matching tasks' : 'You’re all caught up'}</h3>
                      <p>
                        {query
                          ? 'Try a different word or another conversation.'
                          : 'You’re all caught up here. New actions will appear as your chats continue.'}
                      </p>
                    </div>
                  ) : (
                    (
                      [
                        'ready',
                        'needs_info',
                        'waiting',
                        'reported_done',
                      ] satisfies Task['triage_state'][]
                    ).map((group) => {
                      const groupTasks = visible.filter((t) => t.triage_state === group);
                      if (!groupTasks.length) return null;
                      return (
                        <div className="task-group" key={group}>
                          <div className="group-heading">
                            <span className={`group-dot ${group}`} />
                            <h2>
                              {group === 'ready'
                                ? filter === 'done'
                                  ? 'Completed'
                                  : 'Up next'
                                : stateLabel[group]}
                            </h2>
                            <span>{groupTasks.length}</span>
                          </div>
                          {groupTasks.map((t) => (
                            <div
                              className={`task-row ${selected === t.id ? 'selected' : ''} ${t.done ? 'done' : ''}`}
                              key={t.id}
                            >
                              <button
                                className="check-button"
                                aria-label={t.done ? `Reopen: ${t.title}` : `Complete: ${t.title}`}
                                aria-pressed={t.done}
                                onClick={() => void tick(t)}
                              >
                                {t.done ? <CircleCheck size={19} /> : <Circle size={19} />}
                              </button>
                              <button
                                className="task-row-content"
                                aria-label={`Open task: ${t.title}`}
                                onClick={() => setSelected(t.id)}
                              >
                                <span className="task-title">{t.title}</span>
                                <span className="task-row-sub">
                                  <span>{conversationName(t, data.messages, config)}</span>
                                </span>
                              </button>
                              <ChevronRight className="row-chevron" size={14} />
                            </div>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="list-footer">
                  <div>
                    <span className={`live-dot ${!online || data.status.error ? 'warning' : ''}`} />
                    {!online
                      ? 'Reconnecting…'
                      : data.status.error
                        ? 'Needs attention'
                        : data.status.syncing || data.status.pending
                          ? 'Updating tasks…'
                          : data.demo
                            ? 'Sample workspace'
                            : 'Up to date'}
                  </div>
                  <span>
                    {data.status.last_poll
                      ? 'Last checked ' + time(data.status.last_poll)
                      : 'Ready when you are'}
                  </span>
                </div>
              </section>
              <aside className={`inspector ${selectedTask ? 'has-selection' : ''}`}>
                <div className="inspector-heading">
                  <span>
                    {selectedTask
                      ? conversationName(selectedTask, data.messages, config)
                      : 'Task details'}
                  </span>
                  {selectedTask ? (
                    <button
                      className="icon-btn"
                      aria-label="Close task details"
                      onClick={() => setSelected(null)}
                    >
                      <X size={16} />
                    </button>
                  ) : (
                    <MessageSquare size={15} />
                  )}
                </div>
                {selectedTask ? (
                  <TaskDetail
                    key={selectedTask.id}
                    task={selectedTask}
                    messages={data.messages}
                    config={config}
                    onTick={() => void tick(selectedTask)}
                    onSaved={() => void refresh()}
                    notify={setNotice}
                  />
                ) : (
                  <div className="inspector-empty">
                    <span className="focus-art">
                      <FileText size={26} />
                      <span>
                        <Sparkles size={12} />
                      </span>
                    </span>
                    <h3>Your next move, in focus.</h3>
                    <p>
                      Select a task to see the next steps, your notes, and the conversation behind
                      it.
                    </p>
                    <div className="quiet-divider" />
                    <div className="inspector-tip">
                      <Command size={15} />
                      <p>
                        Press <kbd>⌘ K</kbd> to find a task
                        <br />
                        without losing your place.
                      </p>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
        <input
          ref={file}
          type="file"
          accept=".json"
          hidden
          onChange={async (e) => {
            const input = e.target,
              imported = input.files?.[0];
            if (!imported) return;
            try {
              await api('import', OkSchema, JSON.parse(await imported.text()));
              await refresh();
              setNotice('Task ticks imported');
            } catch (err) {
              setNotice(errorMessage(err));
            } finally {
              input.value = '';
            }
          }}
        />
        {notice && (
          <div className="toast" role="status">
            <CircleCheck size={16} />
            <span>{notice}</span>
            <button
              className="icon-btn"
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function conversationName(task: Task, messages: Message[], config: PublicSettings | null) {
  const source = messages.find((message) => task.source_ids.includes(message.id));
  return (
    config?.settings.chats.find(
      (conversation) =>
        conversation.chatId === source?.chatId && conversation.sessionId === source?.sessionId,
    )?.name ?? task.scope
  );
}

function TaskDetail({
  task,
  messages,
  config,
  onTick,
  onSaved,
  notify,
}: {
  task: Task;
  messages: Message[];
  config: PublicSettings | null;
  onTick: () => void;
  onSaved: () => void;
  notify: (text: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'sources'>(() => {
      const params = new URLSearchParams(window.location.search);
      return params.get('task') === task.id && params.get('context') === 'conversation'
        ? 'sources'
        : 'overview';
    }),
    [remark, setRemark] = useState(task.own_remark),
    [saving, setSaving] = useState(false),
    [handoff, setHandoff] = useState(false);
  const sources = messages.filter((m) => task.source_ids.includes(m.id));
  async function save() {
    setSaving(true);
    try {
      await api('remark', OkSchema, { id: task.id, remark });
      onSaved();
      notify('Your note is saved');
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function prepare() {
    setHandoff(true);
    try {
      if (remark !== task.own_remark) {
        await api('remark', OkSchema, { id: task.id, remark });
        onSaved();
      }
      const file = await api('handoff', z.object({ filename: z.string(), content: z.string() }), {
        id: task.id,
      });
      download(file.filename, file.content, 'text/markdown');
      notify('Handoff prepared and downloaded');
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setHandoff(false);
    }
  }
  return (
    <div className="detail-body">
      <div className="detail-scroll">
        <h2 className={task.done ? 'task-done-title' : ''}>{task.title}</h2>
        {task.triage_state !== 'ready' && (
          <div className="detail-status">
            <span className={`group-dot ${task.triage_state}`} />
            {task.done ? 'Completed' : stateLabel[task.triage_state]}
          </div>
        )}
        {tab === 'overview' ? (
          <>
            <p className="task-note">{task.note}</p>
            {task.action_steps.length > 0 && (
              <section className="detail-section">
                <h3>Next steps</h3>
                <ol className="steps">
                  {task.action_steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
            )}
            {task.blocking_question && (
              <div className="blocker">
                <CircleDot size={15} />
                <p>{task.blocking_question}</p>
              </div>
            )}
            <section className="detail-section source-preview">
              <h3>From the conversation</h3>
              {sources[0] && (
                <blockquote>
                  <p>{sources[0].body || 'Image attachment'}</p>
                  <cite>
                    {conversationName(task, messages, config)} · {time(sources[0].timestamp)}
                  </cite>
                </blockquote>
              )}
              <button className="text-button" onClick={() => setTab('sources')}>
                <ArrowUpRight size={16} /> View conversation
                {sources.length > 1 ? ` (${sources.length})` : ''}
              </button>
            </section>
            <details className="detail-section note-section detail-options">
              <summary>Notes &amp; details</summary>
              <h3 className="note-label">Your note</h3>
              <textarea
                aria-label="Your note"
                placeholder="A thought, a link, something to remember…"
                maxLength={4000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                rows={3}
              />
              <button
                className="text-button"
                disabled={saving || remark === task.own_remark}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save note'}
                <Check size={12} />
              </button>

              <p className="detail-scope">
                {task.scope}
                {task.priority === 'high' ? ' · High priority' : ''}
              </p>
              {task.done_when.length > 0 && (
                <>
                  <h3>You’re done when</h3>
                  <ul className="criteria">
                    {task.done_when.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="secondary-actions">
                <button
                  className="button secondary"
                  disabled={handoff}
                  onClick={() => void prepare()}
                >
                  {handoff ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <ArrowUpRight size={14} />
                  )}
                  Handoff
                </button>
                <button
                  className="icon-btn"
                  aria-label="Copy raw task context"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        JSON.stringify({ task, source_messages: sources }, null, 2),
                      );
                      notify('Task context copied');
                    } catch {
                      notify('Clipboard unavailable. Use Export workspace from the task menu.');
                    }
                  }}
                >
                  <Copy size={15} />
                </button>
              </div>
              <p className="updated-note">Updated {time(task.updated)}</p>
            </details>
          </>
        ) : (
          <div className="source-list">
            <button className="text-button" onClick={() => setTab('overview')}>
              Back to task
            </button>
            <p className="source-intro">
              The messages behind this task. Dates use your local timezone.
            </p>
            {sources.map((m) => (
              <MessageCard
                key={m.id}
                message={m}
                name={
                  config?.settings.chats.find(
                    (c) => c.chatId === m.chatId && c.sessionId === m.sessionId,
                  )?.name ?? 'Contact'
                }
                allMessages={messages}
              />
            ))}
          </div>
        )}
      </div>
      <div className="detail-actions">
        <button className={`button ${task.done ? 'secondary' : 'primary'}`} onClick={onTick}>
          {task.done ? 'Reopen task' : 'Mark Complete'}
        </button>
      </div>
    </div>
  );
}
function MessageCard({
  message: m,
  name,
  allMessages,
}: {
  message: Message;
  name: string;
  allMessages: Message[];
}) {
  const [failed, setFailed] = useState(false);
  return (
    <article className={`message-card ${m.direction}`} id={`message-${m.id}`}>
      <div className="message-heading">
        <span className="tiny-avatar">{m.direction === 'outgoing' ? 'Y' : name.slice(0, 1)}</span>
        <strong>{m.direction === 'outgoing' ? 'You' : name}</strong>
        <time>{time(m.timestamp)}</time>
      </div>
      {m.reply_to_wa_id && (
        <blockquote>
          {m.reply_quote ||
            allMessages.find((p) => p.id === m.reply_to_id)?.body ||
            'Quoted attachment'}
        </blockquote>
      )}
      <p>{m.body || '[Attachment without a caption]'}</p>
      {m.browser_source && (
        <p className="browser-source-label">
          Captured selection · {m.browser_source.title} · WhatsApp Web
        </p>
      )}
      {m.type === 'image' &&
        (failed ? (
          <div className="image-unavailable">
            <TriangleAlert size={15} />
            <span>The original image is unavailable from OpenWA.</span>
          </div>
        ) : (
          <a href={`/api/media?id=${encodeURIComponent(m.id)}`} target="_blank" rel="noreferrer">
            <img
              src={`/api/media?id=${encodeURIComponent(m.id)}`}
              alt={`Attachment from ${name}, ${time(m.timestamp)}`}
              loading="lazy"
              onError={() => setFailed(true)}
            />
          </a>
        ))}
      {m.image_reading && (
        <details>
          <summary>What AI could read</summary>
          {m.image_reading.observations.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
          {m.image_reading.uncertainties.map((text, i) => (
            <p className="uncertainty" key={i}>
              {text}
            </p>
          ))}
        </details>
      )}
    </article>
  );
}
function ActivityView({ data, onSync }: { data: Snapshot; onSync: () => void }) {
  return (
    <div className="settings-page">
      <div className="eyebrow">YOUR WORKSPACE, AT A GLANCE</div>
      <h1>Quietly keeping up.</h1>
      <p className="page-description">See what’s happening between conversations and tasks.</p>
      <div className="activity-grid">
        <section className="settings-card">
          <span className="card-icon">
            <Zap size={20} />
          </span>
          <h2>{data.status.phase}</h2>
          <p>
            {data.status.error ??
              'Messages arrive through signed webhooks. Your trigger settings decide when task analysis runs.'}
          </p>
          <button className="button secondary" onClick={onSync}>
            Run now <ArrowUpRight size={14} />
          </button>
        </section>
        <section className="settings-card">
          <span className="card-icon">
            <Sparkles size={20} />
          </span>
          <h2>{data.usage.calls.toLocaleString()} AI calls</h2>
          <p>
            {data.usage.totalTokens.toLocaleString()} tokens recorded. Provider billing and
            subscription limits are managed by your provider.
          </p>
          <span className="label">{data.usage.model}</span>
        </section>
      </div>
      {data.status.last_decision && (
        <section className="settings-card">
          <h2>Last trigger decision · {data.status.last_decision.choice}</h2>
          <p>{data.status.last_decision.reason}</p>
          <span className="label">{data.status.last_decision.connection}</span>
        </section>
      )}
      <section className="settings-card">
        <h2>Recent conversation</h2>
        {[...data.messages]
          .reverse()
          .slice(0, 12)
          .map((m) => (
            <div className="activity-row" key={m.id}>
              <MessageSquare size={15} />
              <div>
                <strong>{m.direction === 'outgoing' ? 'You' : 'Incoming message'}</strong>
                <p>{m.body || `[${m.type}]`}</p>
              </div>
              <time>{time(m.timestamp)}</time>
            </div>
          ))}
        {!data.messages.length && (
          <p>Your first messages will appear after you activate a conversation.</p>
        )}
      </section>
      <div className="privacy-strip">
        <ShieldCheck size={16} />
        <p>
          Conversations stay on your server. Activated chats are sent to the model connection you
          choose.
        </p>
      </div>
    </div>
  );
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

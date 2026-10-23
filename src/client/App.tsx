import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  Command,
  Copy,
  FileText,
  Inbox,
  LoaderCircle,
  Menu,
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
  const [data, setData] = useState(empty),
    [config, setConfig] = useState<PublicSettings | null>(null);
  const [view, setView] = useState<View>('tasks'),
    [filter, setFilter] = useState<'open' | 'all' | 'done'>('open');
  const [query, setQuery] = useState(''),
    [chat, setChat] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState(''),
    [online, setOnline] = useState(true),
    [mobileMenu, setMobileMenu] = useState(false),
    [showMenu, setShowMenu] = useState(false);
  const search = useRef<HTMLInputElement>(null),
    file = useRef<HTMLInputElement>(null);
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
  const enabled = settings?.chats.filter((c) => c.enabled) ?? [],
    currentChat = settings?.chats.find((c) => c.id === chat);
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
  const done = scoped.filter((t) => t.done).length;
  async function tick(task: Task) {
    try {
      await api('tick', OkSchema, { id: task.id, done: !task.done });
      await refresh();
      setNotice(task.done ? 'Moved back to your tasks' : 'One less thing. Task completed.');
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  async function changeModel(id: string) {
    if (!settings) return;
    try {
      setConfig(
        await api('settings', PublicSettingsSchema, {
          settings: { ...settings, activeProfileId: id },
        }),
      );
      setNotice('Model connection updated');
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  async function sync() {
    try {
      await api('sync', OkSchema, {});
      setNotice('Checking for new messages…');
      await refresh();
    } catch (e) {
      setNotice(errorMessage(e));
    }
  }
  const title =
    view === 'tasks'
      ? (currentChat?.name ?? 'My tasks')
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
          <span className="brand-mark">
            <MessageSquare size={18} />
            <Check size={10} />
          </span>
          <span>
            chat2tasks<small>{data.demo ? 'Sample workspace' : 'Personal workspace'}</small>
          </span>
          <ChevronDown size={13} />
        </button>
        <button
          className="search-shortcut"
          onClick={() => {
            navigate('tasks');
            search.current?.focus();
          }}
        >
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">Workspace</div>
        <nav aria-label="Workspace">
          <button
            className={view === 'tasks' && !chat ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setChat(null);
              navigate('tasks');
            }}
          >
            <Inbox size={17} />
            <span>My tasks</span>
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
            className={view === 'activity' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('activity')}
          >
            <Activity size={17} />
            <span>Activity</span>
            {data.status.syncing && <span className="live-dot" />}
          </button>
        </nav>
        <div className="nav-label conversation-label">
          Following{' '}
          <button
            className="icon-btn"
            aria-label="Add a conversation"
            onClick={() => navigate('chats')}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav aria-label="Followed chats" className="chat-nav">
          {enabled.map((c) => (
            <button
              key={c.id}
              className={chat === c.id && view === 'tasks' ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                setChat(c.id);
                navigate('tasks');
                setSelected(null);
              }}
            >
              <span className="tiny-avatar">{c.name.slice(0, 1)}</span>
              <span>{c.name}</span>
              <span className="live-dot" />
            </button>
          ))}
          {!enabled.length && (
            <p className="sidebar-hint">
              Your active conversations
              <br />
              will appear here.
            </p>
          )}
        </nav>
        <button className="add-chat" onClick={() => navigate('chats')}>
          <Plus size={14} /> Add a conversation
        </button>
        <div className="sidebar-bottom">
          <button
            className={view === 'models' ? 'nav-item active' : 'nav-item'}
            onClick={() => navigate('models')}
          >
            <Settings2 size={17} />
            <span>Settings & connections</span>
          </button>
          <div className="model-card">
            <div className="model-label">
              <Sparkles size={14} />
              <span>Intelligence</span>
              <span className={`live-dot ${online ? '' : 'offline'}`} />
            </div>
            <div className="model-select">
              <select
                aria-label="Active model connection"
                value={settings?.activeProfileId ?? ''}
                onChange={(e) => void changeModel(e.target.value)}
              >
                {settings?.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
            <button className="text-button" onClick={() => navigate('models')}>
              Manage models <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="local-note">
            <ShieldCheck size={12} />
            <span>Your workspace. Your data.</span>
          </div>
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
              <Menu size={18} />
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
                    : 'Workspace connected'}
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
            <section className="page-heading">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" /> FROM CONVERSATION TO CLARITY
                </div>
                <h1>{currentChat ? currentChat.name : 'A little less to keep in mind.'}</h1>
                <p>Your conversations, distilled into what comes next.</p>
              </div>
              <button
                className="button secondary"
                onClick={() => void sync()}
                disabled={data.status.syncing}
              >
                <span className={data.status.syncing ? 'spin icon-wrap' : 'icon-wrap'}>
                  <Zap size={14} />
                </span>{' '}
                Sync messages
              </button>
            </section>
            <div className="task-layout">
              <section className="task-column">
                <div className="task-toolbar">
                  <div className="tabs" role="tablist" aria-label="Task status">
                    {(
                      [
                        ['open', 'To do'],
                        ['all', 'All tasks'],
                        ['done', 'Completed'],
                      ] satisfies [typeof filter, string][]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        role="tab"
                        aria-selected={filter === value}
                        className={filter === value ? 'selected' : ''}
                        onClick={() => setFilter(value)}
                      >
                        {label}
                        <span>
                          {value === 'open'
                            ? scoped.length - done
                            : value === 'done'
                              ? done
                              : scoped.length}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="task-toolbar-end">
                    <div className="search-field">
                      <Search size={14} />
                      <input
                        ref={search}
                        aria-label="Search tasks"
                        placeholder="Search tasks…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon-btn"
                          aria-label="Clear search"
                          onClick={() => setQuery('')}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <div className="menu-anchor">
                      <button
                        className="icon-btn"
                        aria-label="More task actions"
                        aria-expanded={showMenu}
                        onClick={() => setShowMenu(!showMenu)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      {showMenu && (
                        <div className="popover">
                          <button
                            onClick={() => {
                              download('chat2tasks-export.json', JSON.stringify(data, null, 2));
                              setShowMenu(false);
                            }}
                          >
                            <ArrowDownToLine size={14} /> Export workspace
                          </button>
                          <button
                            onClick={() => {
                              file.current?.click();
                              setShowMenu(false);
                            }}
                          >
                            <FileText size={14} /> Import task ticks
                          </button>
                        </div>
                      )}
                    </div>
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
                      <h3>{query ? 'No matching tasks' : 'A clear head looks good on you.'}</h3>
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
                                  <span>{t.scope}</span>
                                  <span>·</span>
                                  <MessageSquare size={11} />
                                  <span>{t.source_ids.length} sources</span>
                                </span>
                              </button>
                              {t.priority === 'high' && (
                                <span className="priority-mark" title="High priority">
                                  ↑
                                </span>
                              )}
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
                    <span className="live-dot" />
                    {enabled.length} active conversation{enabled.length !== 1 ? 's' : ''}
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
                  <span>{selectedTask ? 'TASK DETAILS' : 'A LITTLE CONTEXT'}</span>
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
                <div className="inspector-foot">
                  <ShieldCheck size={13} /> Original context, always close.
                </div>
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
        <footer className="workspace-footer">
          <span>
            <span className="footer-logo">c2t</span> A quieter kind of productivity.
          </span>
          <a href="https://github.com/liongkj/chat2tasks" target="_blank" rel="noreferrer">
            Open source <ArrowUpRight size={12} />
          </a>
        </footer>
      </main>
    </div>
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
  const [tab, setTab] = useState<'overview' | 'sources'>('overview'),
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
      <div className="detail-meta">
        <span className="label">{task.scope}</span>
        {task.priority === 'high' && <span className="label amber">High priority</span>}
      </div>
      <h2 className={task.done ? 'task-done-title' : ''}>{task.title}</h2>
      <div className="detail-status">
        <span className={`group-dot ${task.triage_state}`} />
        {task.done ? 'Completed' : stateLabel[task.triage_state]}
      </div>
      <div className="detail-tabs">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
          Overview
        </button>
        <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>
          Conversation <span>{sources.length}</span>
        </button>
      </div>
      {tab === 'overview' ? (
        <>
          <p className="task-note">{task.note}</p>
          {task.action_steps.length > 0 && (
            <section className="detail-section">
              <h3>
                <ArrowUpRight size={14} /> Next steps
              </h3>
              <ol className="steps">
                {task.action_steps.map((s, i) => (
                  <li key={i}>
                    <span>{i + 1}</span>
                    <p>{s}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {task.done_when.length > 0 && (
            <section className="detail-section">
              <h3>
                <CircleCheck size={14} /> You’re done when
              </h3>
              <ul className="criteria">
                {task.done_when.map((s, i) => (
                  <li key={i}>
                    <Check size={13} />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {task.blocking_question && (
            <div className="blocker">
              <CircleDot size={15} />
              <p>{task.blocking_question}</p>
            </div>
          )}
          <section className="detail-section note-section">
            <h3>
              <FileText size={14} /> Your note <span>Only in your workspace</span>
            </h3>
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
          </section>
          <div className="detail-actions">
            <button className={`button ${task.done ? 'secondary' : 'primary'}`} onClick={onTick}>
              <Check size={15} />
              {task.done ? 'Reopen task' : 'Mark complete'}
            </button>
            <button className="button secondary" disabled={handoff} onClick={() => void prepare()}>
              {handoff ? <LoaderCircle size={14} className="spin" /> : <ArrowUpRight size={14} />}
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
        </>
      ) : (
        <div className="source-list">
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
              'New conversations are checked automatically. Task generation never sends messages to WhatsApp.'}
          </p>
          <button className="button secondary" onClick={onSync}>
            Check now <ArrowUpRight size={14} />
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Link2,
  ListTree,
  Menu as MenuIcon,
  MessageCircle,
  SquareCheck,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { RefreshGate } from '../shared/refresh.js';
import { useInputModality } from '../shared/useInputModality.js';
import {
  PublicSettingsSchema,
  SnapshotSchema,
  type PublicSettings,
  type Snapshot,
  type Task,
  type TaskEvidence,
} from '../shared/schema.js';
import { matchesTaskIdentifier, matchesTaskQuery } from '../shared/tasks.js';
import { api, download, OkSchema } from './api.js';
import { ConversationWorkspace } from './ConversationWorkspace.js';
import { ThreadsPage } from './ThreadsPage.js';
import { conversationName, messagesForChat, tasksForMessages } from './conversations.js';
import { ActivityView } from './Activity.js';
import { SettingsPanel } from './Settings.js';
import { TaskDetail } from './TaskDetail.js';
import { TaskQueue } from './TaskQueue.js';
import { TaskFilters } from './TaskFilters.js';
import { Overview } from './Overview.js';
import { ReviewView } from './ReviewView.js';
import { WaitingView } from './WaitingView.js';
import { WorkspaceImport } from './WorkspaceImport.js';
import { deskTitle, matchesTaskFilter, tasksForDesk } from './taskDesk.js';
import { useWorkspaceLocation, type SettingsSection, type WorkspaceView } from './taskLocation.js';

const settingsSections: { id: SettingsSection; label: string }[] = [
  { id: 'conversations', label: 'WhatsApp & chats' },
  { id: 'models', label: 'AI models' },
  { id: 'automation', label: 'Automation' },
  { id: 'attention', label: 'Attention' },
  { id: 'workspace', label: 'Move workspace' },
  { id: 'browser', label: 'Browser' },
];

const empty: Snapshot = {
  demo: false,
  tasks: [],
  waiting_for: [],
  messages: [],
  questions: [],
  status: { syncing: false, phase: 'Connecting', pending: 0, error: null, debouncing: false },
  usage: { calls: 0, totalTokens: 0, model: '' },
};
function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}
type Notice =
  | { kind: 'message'; text: string }
  | { kind: 'completion'; text: string; taskId: Task['id']; previousDone: boolean; done: boolean };
export function App() {
  useInputModality();
  const narrow = useNarrowLayout();
  const { location, updateLocation } = useWorkspaceLocation();
  const [data, setData] = useState(empty);
  const [config, setConfig] = useState<PublicSettings | null>(null);
  const [configError, setConfigError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [requestingSync, setRequestingSync] = useState(false);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const notify = useCallback((text: string) => setNoticeState({ kind: 'message', text }), []);
  const [mobileMenu, setMobileMenu] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const taskReturnFocus = useRef<{
    element: HTMLElement | null;
    reference: Task['reference'];
  } | null>(null);
  const initialized = useRef<string | null>(null);
  const restoredSelection = useRef<string | null>(null);
  const refreshGate = useRef(new RefreshGate());
  const pendingTicks = useRef(new Map<string, boolean>());
  const [pendingTickIds, setPendingTickIds] = useState<Set<string>>(new Set());
  const refresh = useCallback(async () => {
    const ticket = refreshGate.current.start();
    try {
      const next = await api('state', SnapshotSchema);
      if (!refreshGate.current.accept(ticket)) return;
      setData({
        ...next,
        tasks: next.tasks.map((task) => {
          const pending = pendingTicks.current.get(task.id);
          return pending === undefined ? task : { ...task, done: pending };
        }),
      });
      setLoaded(true);
      setOnline(true);
    } catch {
      if (refreshGate.current.accept(ticket)) setOnline(false);
    }
  }, []);
  const refreshConfig = useCallback(async () => {
    setConfigError('');
    try {
      setConfig(await api('settings', PublicSettingsSchema));
    } catch (error) {
      setConfigError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshConfig();
  }, [refresh, refreshConfig]);
  useEffect(() => {
    const interval = data.status.syncing || data.status.debouncing || requestingSync ? 1000 : 5000;
    const timer = setInterval(() => void refresh(), interval);
    return () => clearInterval(timer);
  }, [refresh, data.status.syncing, data.status.debouncing, requestingSync]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNoticeState(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const chats = config?.settings.chats ?? [];
  const chat = chats.find((item) => item.id === location.chat);
  const selectedTask = data.tasks.find((task) => matchesTaskIdentifier(task, location.task));
  useEffect(() => {
    if (!loaded || !config || narrow) return;
    if (location.task) return;
    if (location.view === 'conversations') {
      if (location.message) return;
      const key = `${location.view}:${location.chat ?? ''}`;
      if (initialized.current === key) return;
      initialized.current = key;
      const current = chat ?? chats[0];
      if (!current) return;
      const related = tasksForMessages(data.tasks, messagesForChat(current, data.messages));
      const next = related
        .filter((task) => !task.done)
        .sort(
          (a, b) =>
            Number(b.priority === 'high') - Number(a.priority === 'high') || b.updated - a.updated,
        )
        .at(0);
      updateLocation({ chat: current.id, task: next?.reference ?? null }, { replace: true });
    } else if (location.view === 'tasks') {
      const next = tasksForDesk({ tasks: data.tasks, messages: data.messages, chats, location }).at(
        0,
      );
      if (next) updateLocation({ task: next.reference }, { replace: true });
    }
  }, [
    loaded,
    config,
    narrow,
    location.view,
    location.chat,
    location.task,
    location.message,
    location.filter,
    location.kind,
    location.query,
    chat,
    chats,
    data,
    updateLocation,
  ]);
  useEffect(() => {
    if (!location.task) {
      restoredSelection.current = null;
      return;
    }
    if (
      !loaded ||
      !selectedTask ||
      restoredSelection.current === location.task ||
      ((location.view === 'conversations' || location.chat) && !config)
    )
      return;
    restoredSelection.current = location.task;
    const linkedChat = chats.find((item) =>
      messagesForChat(item, data.messages).some((message) =>
        selectedTask.source_ids.includes(message.id),
      ),
    );
    updateLocation(
      {
        task: selectedTask.reference,
        ...(location.view === 'tasks' && !matchesTaskFilter(selectedTask, location.filter)
          ? { filter: selectedTask.done ? 'done' : 'open' }
          : {}),
        ...(location.view === 'tasks' &&
        location.kind !== 'all' &&
        location.kind !== 'someday' &&
        location.kind !== 'upcoming' &&
        location.kind !== 'projects' &&
        location.kind !== 'areas' &&
        selectedTask.kind !== location.kind
          ? { kind: selectedTask.kind }
          : {}),
        ...(location.view === 'conversations' && !chat ? { chat: linkedChat?.id ?? null } : {}),
        ...(location.view === 'tasks' &&
        chat &&
        !tasksForMessages([selectedTask], messagesForChat(chat, data.messages)).length
          ? { chat: null }
          : {}),
        ...(!matchesTaskQuery(selectedTask, location.query) ? { query: '' } : {}),
      },
      { replace: true },
    );
  }, [
    location.task,
    location.view,
    location.filter,
    location.kind,
    location.query,
    selectedTask,
    loaded,
    config,
    chats,
    chat,
    data.messages,
    updateLocation,
  ]);
  const navigate = (view: WorkspaceView) => {
    setMobileMenu(false);
    updateLocation({
      view,
      message: null,
      task: null,
      wait: null,
      tab: 'overview',
      expanded: false,
      chat: null,
      query: '',
      filter: 'open',
      kind: 'all',
      settingsSection: view === 'connections' ? 'conversations' : 'models',
    });
  };
  useEffect(() => {
    return window.chat2tasksDesktop?.onOpenSettings(() => {
      setMobileMenu(false);
      updateLocation({
        view: 'settings',
        message: null,
        task: null,
        wait: null,
        tab: 'overview',
        expanded: false,
        chat: null,
        query: '',
        filter: 'open',
        kind: 'all',
        settingsSection: 'models',
      });
    });
  }, [updateLocation]);
  useEffect(() => {
    if (location.view === 'tasks' && focusSearch.current) {
      search.current?.focus();
      focusSearch.current = false;
    }
  }, [location.view]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        focusSearch.current = true;
        updateLocation({
          view: 'tasks',
          task: null,
          chat: null,
          filter: 'open',
          kind: 'all',
          query: '',
          tab: 'overview',
          expanded: false,
        });
        search.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [updateLocation]);
  const viewTitle =
    location.view === 'overview'
      ? 'Overview'
      : location.view === 'waiting'
        ? 'Waiting for'
        : location.view === 'review'
          ? 'Review'
          : location.view === 'connections'
            ? 'Connections'
            : location.view === 'conversations'
              ? 'Conversations'
              : location.view === 'threads'
                ? 'Threads'
                : location.view === 'tasks'
                  ? deskTitle(location)
                  : location.view === 'settings'
                    ? 'Settings'
                    : 'Activity';
  useEffect(() => {
    document.title = `Chat2Tasks — ${chat && location.view === 'conversations' ? chat.name : viewTitle}`;
  }, [viewTitle, chat, location.view]);
  async function tick(task: Task, done = !task.done) {
    if (pendingTicks.current.has(task.id) || task.done === done) return;
    if (done && task.gtd.recurrence) {
      pendingTicks.current.set(task.id, done);
      setPendingTickIds(new Set(pendingTicks.current.keys()));
      try {
        const result = await api('tasks/occurrence', OkSchema, {
          id: task.id,
          date: task.gtd.recurrence.next_date,
        });
        if (!result.ok)
          throw new Error('This occurrence has already changed. Refresh and try again.');
        pendingTicks.current.delete(task.id);
        setPendingTickIds(new Set(pendingTicks.current.keys()));
        await refresh();
        notify('Occurrence completed');
      } catch (error) {
        notify(errorMessage(error));
        void refresh();
      } finally {
        pendingTicks.current.delete(task.id);
        setPendingTickIds(new Set(pendingTicks.current.keys()));
      }
      return;
    }
    pendingTicks.current.set(task.id, done);
    setPendingTickIds(new Set(pendingTicks.current.keys()));
    refreshGate.current.invalidate();
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((item) => (item.id === task.id ? { ...item, done } : item)),
    }));
    try {
      await api('tick', OkSchema, { id: task.id, done });
      refreshGate.current.invalidate();
      pendingTicks.current.delete(task.id);
      setPendingTickIds(new Set(pendingTicks.current.keys()));
      setNoticeState({
        kind: 'completion',
        text: done
          ? task.kind === 'question'
            ? 'Question answered'
            : task.kind === 'reminder'
              ? 'Reminder dismissed'
              : 'Task completed'
          : task.kind === 'question'
            ? 'Question reopened'
            : task.kind === 'reminder'
              ? 'Reminder restored'
              : 'Task reopened',
        taskId: task.id,
        previousDone: task.done,
        done,
      });
    } catch (error) {
      pendingTicks.current.delete(task.id);
      setPendingTickIds(new Set(pendingTicks.current.keys()));
      refreshGate.current.invalidate();
      setData((current) => ({
        ...current,
        tasks: current.tasks.map((item) =>
          item.id === task.id ? { ...item, done: task.done } : item,
        ),
      }));
      void refresh();
      notify(errorMessage(error));
    }
  }
  async function sync() {
    if (requestingSync || data.status.syncing) return;
    setRequestingSync(true);
    try {
      await api('sync', OkSchema, {});
      notify(
        data.demo ? 'Sample workspace · live analysis is disabled' : 'Checking your conversations',
      );
      await refresh();
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setRequestingSync(false);
    }
  }
  const openTask = (task: Task, expanded = true) => {
    taskReturnFocus.current = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      reference: task.reference,
    };
    updateLocation({ task: task.reference, tab: 'overview', expanded, message: null });
  };
  const openInDesk = (task: Task) => {
    taskReturnFocus.current = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      reference: task.reference,
    };
    updateLocation({
      view: 'tasks',
      kind: !task.done && task.gtd.commitment === 'someday' ? 'someday' : task.kind,
      task: task.reference,
      wait: null,
      chat: null,
      query: '',
      filter: task.done ? 'done' : 'open',
      tab: 'overview',
      expanded: true,
    });
  };
  const closeTask = () =>
    updateLocation(
      location.view === 'conversations'
        ? { expanded: false }
        : { task: null, expanded: false, tab: 'overview' },
    );
  const onMerged = (evidence: TaskEvidence) => {
    if (!selectedTask) return;
    refreshGate.current.invalidate();
    setData((current) => ({
      ...current,
      tasks: [
        ...current.tasks.filter(
          (task) => task.id !== selectedTask.id && task.id !== evidence.task.id,
        ),
        {
          ...evidence.task,
          done: pendingTicks.current.get(evidence.task.id) ?? evidence.task.done,
        },
      ],
      messages: [
        ...new Map(
          [...current.messages, ...evidence.messages].map((message) => [message.id, message]),
        ).values(),
      ].sort((a, b) => a.timestamp - b.timestamp),
    }));
    updateLocation({ task: evidence.task.reference }, { replace: true });
    void refresh();
  };
  const detail = selectedTask ? (
    <TaskDetail
      key={selectedTask.id}
      layout={location.view === 'tasks' ? 'desk' : 'context'}
      task={selectedTask}
      tasks={data.tasks}
      messages={data.messages}
      chats={chats}
      tab={location.view === 'conversations' ? 'overview' : location.tab}
      onTabChange={(tab) => {
        const sourceChats = new Set(
          data.messages
            .filter((message) => selectedTask.source_ids.includes(message.id))
            .map((message) => `${message.sessionId}\0${message.chatId}`),
        );
        updateLocation({
          tab,
          ...(location.view === 'conversations' ? { expanded: false } : {}),
          ...(tab === 'sources' && location.view === 'conversations' && sourceChats.size > 1
            ? { view: 'tasks', chat: null, filter: selectedTask.done ? 'done' : 'open' }
            : {}),
        });
      }}
      onTick={() => void tick(selectedTask)}
      ticking={pendingTickIds.has(selectedTask.id)}
      onSaved={() => void refresh()}
      onKindChanged={(kind) => {
        if (
          location.view === 'tasks' &&
          location.kind !== 'all' &&
          location.kind !== 'someday' &&
          location.kind !== 'upcoming' &&
          location.kind !== 'projects' &&
          location.kind !== 'areas'
        )
          updateLocation({ kind });
        void refresh();
      }}
      onMerged={onMerged}
      notify={notify}
    />
  ) : (
    <div className="inspector-empty">
      <Link2 size={27} />
      <h2>{!loaded ? 'Loading tasks…' : location.task ? 'Task not found' : 'Choose a task'}</h2>
      <p>
        {!loaded
          ? 'Your saved work will appear here.'
          : location.task
            ? 'This task link is no longer available. Choose another task.'
            : 'Its next steps, completion criteria and original messages will appear here.'}
      </p>
    </div>
  );
  const inspectorHeading = (
    <div className="inspector-heading">
      <div>
        <Link2 size={15} />
        <span>
          {selectedTask
            ? `Linked to ${selectedTask.source_ids.length} ${selectedTask.source_ids.length === 1 ? 'message' : 'messages'}`
            : 'Task details'}
          {selectedTask && <small>{conversationName(selectedTask, data.messages, chats)}</small>}
        </span>
      </div>
      <button
        className="icon-btn"
        aria-label="Close task details"
        onClick={() =>
          location.view === 'conversations' && !narrow
            ? updateLocation({ task: null, tab: 'overview' })
            : closeTask()
        }
      >
        <X size={17} />
      </button>
    </div>
  );
  const inspector = !narrow ? (
    <aside
      className={`inspector ${location.view === 'tasks' ? 'desk-inspector' : ''}`}
      aria-label="Task details"
    >
      {location.view !== 'tasks' && inspectorHeading}
      {detail}
    </aside>
  ) : null;
  const navigation = (
    <>
      <button className="brand" onClick={() => navigate('overview')}>
        <SquareCheck size={20} /> <span>chat2tasks</span>
      </button>
      <TaskFilters
        tasks={data.tasks}
        loaded={loaded}
        messages={data.messages}
        chats={chats}
        waits={data.waiting_for}
        pendingQuestions={data.questions.length}
        location={location}
        onLocation={(patch) => {
          setMobileMenu(false);
          updateLocation(patch);
        }}
      />
      <div className="sidebar-bottom">
        <button
          className={`nav-item ${location.view === 'threads' ? 'active' : ''}`}
          aria-current={location.view === 'threads' ? 'page' : undefined}
          onClick={() => navigate('threads')}
        >
          <ListTree size={16} />
          <span>Threads</span>
        </button>
        <button
          className={`nav-item ${location.view === 'conversations' ? 'active' : ''}`}
          aria-current={location.view === 'conversations' ? 'page' : undefined}
          onClick={() => navigate('conversations')}
        >
          <MessageCircle size={16} />
          <span>Conversations</span>
        </button>
        <button
          className={`nav-item ${location.view === 'activity' ? 'active' : ''}`}
          onClick={() => navigate('activity')}
        >
          <Activity size={16} />
          <span>Activity</span>
        </button>
        <button
          className={`nav-item ${location.view === 'settings' || location.view === 'connections' ? 'active' : ''}`}
          onClick={() => navigate('settings')}
        >
          <Settings2 size={16} />
          <span>Settings</span>
        </button>
        <span
          className={`workspace-presence ${!online || data.status.error ? 'warning' : ''}`}
          title={
            !online
              ? 'Workspace unavailable'
              : (data.status.error ??
                (data.demo
                  ? 'Sample workspace'
                  : window.chat2tasksDesktop
                    ? 'Workspace on this computer'
                    : 'Workspace server available'))
          }
        >
          <span className="owner-avatar">Y</span>
          <span className="presence-copy">
            Your workspace
            <small>
              {!online
                ? 'Reconnecting…'
                : data.status.error
                  ? 'Needs attention'
                  : data.demo
                    ? 'Sample data'
                    : window.chat2tasksDesktop
                      ? 'On this computer'
                      : 'Server available'}
            </small>
          </span>
        </span>
      </div>
    </>
  );
  const navigationTrigger = (
    <Dialog.Trigger className="icon-btn mobile-toggle" aria-label="Open navigation">
      <MenuIcon size={21} />
    </Dialog.Trigger>
  );
  const taskDialogOpen =
    narrow && !!location.task && (location.view === 'tasks' || location.expanded);
  const undo = notice?.kind === 'completion' ? notice : null;
  const undoTask = undo ? data.tasks.find((task) => task.id === undo.taskId) : undefined;
  const notification = notice && (
    <div className="toast" role="status">
      <CheckCircle2 size={17} />
      <span>{notice.text}</span>
      {undo && (
        <button
          className="toast-undo"
          disabled={!undoTask || undoTask.done !== undo.done || pendingTickIds.has(undo.taskId)}
          onClick={() => {
            if (undoTask) void tick(undoTask, undo.previousDone);
          }}
        >
          Undo
        </button>
      )}
      <button
        className="icon-btn"
        aria-label="Dismiss notification"
        onClick={() => setNoticeState(null)}
      >
        <X size={15} />
      </button>
    </div>
  );
  const questions = data.questions
    .filter((question) => {
      if (location.view !== 'conversations') return true;
      const message = data.messages.find((item) => item.id === question.message_id);
      return chat && message?.chatId === chat.chatId && message.sessionId === chat.sessionId;
    })
    .map((question) => (
      <div className="question-card" key={question.id}>
        <h3>{question.question}</h3>
        <p>{data.messages.find((message) => message.id === question.message_id)?.body}</p>
        <div className="form-inline">
          <select
            aria-label="Choose the completed task"
            defaultValue=""
            onChange={async (event) => {
              if (!event.target.value) return;
              try {
                await api('resolve', OkSchema, { id: question.id, task_id: event.target.value });
                await refresh();
              } catch (error) {
                notify(errorMessage(error));
              }
            }}
          >
            <option value="" disabled>
              Choose the completed task…
            </option>
            {data.tasks
              .filter((task) => {
                const message = data.messages.find((item) => item.id === question.message_id);
                return (
                  message &&
                  task.source_ids.some((id) =>
                    data.messages.some(
                      (source) =>
                        source.id === id &&
                        source.chatId === message.chatId &&
                        source.sessionId === message.sessionId,
                    ),
                  )
                );
              })
              .map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
          </select>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await api('resolve', OkSchema, { id: question.id, task_id: null });
                await refresh();
              } catch (error) {
                notify(errorMessage(error));
              }
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    ));
  return (
    <>
      <Dialog.Root open={mobileMenu} onOpenChange={setMobileMenu}>
        <div className="app">
          <aside className="sidebar">{navigation}</aside>
          <main className="workspace">
            {location.view !== 'conversations' &&
              location.view !== 'tasks' &&
              location.view !== 'overview' &&
              location.view !== 'waiting' &&
              location.view !== 'review' && (
                <header className="topbar">
                  {navigationTrigger}
                  <span>{viewTitle}</span>
                  <span className="topbar-status">
                    {data.demo
                      ? 'Sample workspace'
                      : !online
                        ? 'Reconnecting…'
                        : data.status.error
                          ? 'Needs attention'
                          : data.status.syncing
                            ? data.status.phase
                            : data.status.debouncing
                              ? 'Waiting to check…'
                              : 'Your workspace'}
                  </span>
                </header>
              )}
            {data.status.error && (
              <div className="inline-alert">
                <TriangleAlert size={17} />
                <p>{data.status.error}</p>
                <button className="text-button" onClick={() => navigate('activity')}>
                  View activity
                </button>
              </div>
            )}
            {!online && (
              <div className="inline-alert" role="alert">
                <TriangleAlert size={17} />
                <p>
                  {loaded
                    ? 'Reconnecting to your workspace. Showing saved data.'
                    : 'Couldn’t reach your workspace. Retrying automatically.'}
                </p>
                <button className="text-button" onClick={() => void refresh()}>
                  Try again
                </button>
              </div>
            )}
            {!config && configError && online && (
              <div className="inline-alert" role="alert">
                <TriangleAlert size={17} />
                <p>Couldn’t load your conversations and settings. {configError}</p>
                <button className="text-button" onClick={() => void refreshConfig()}>
                  Reload settings
                </button>
              </div>
            )}
            {location.view === 'overview' ? (
              <Overview
                tasks={data.tasks}
                waits={data.waiting_for}
                pendingQuestions={data.questions.length}
                loaded={loaded}
                online={online}
                messageCount={data.messages.length}
                followedConversations={
                  config ? config.settings.chats.filter((item) => item.enabled).length : null
                }
                status={data.status}
                requestingSync={requestingSync}
                onActivity={() => navigate('activity')}
                onConnections={() => navigate('connections')}
                onImportWorkspace={
                  window.chat2tasksDesktop ? () => setWorkspaceImportOpen(true) : undefined
                }
                onOpenTask={openInDesk}
                onOpenWait={(wait) =>
                  updateLocation({ view: 'waiting', wait: wait.id, task: null })
                }
                onCategory={(kind) =>
                  updateLocation({
                    view: 'tasks',
                    kind,
                    task: null,
                    wait: null,
                    chat: null,
                    query: '',
                    filter: 'open',
                  })
                }
                onWaiting={() => navigate('waiting')}
                onUpcoming={() =>
                  updateLocation({
                    view: 'tasks',
                    kind: 'upcoming',
                    task: null,
                    wait: null,
                    chat: null,
                    query: '',
                    filter: 'open',
                  })
                }
                onReview={() => navigate('review')}
                navigationTrigger={navigationTrigger}
              />
            ) : location.view === 'waiting' ? (
              <WaitingView
                waits={data.waiting_for}
                tasks={data.tasks}
                messages={data.messages}
                chats={chats}
                selectedId={location.wait ?? null}
                onSelect={(wait) => updateLocation({ wait })}
                onOpenTask={openInDesk}
                onRefresh={refresh}
                notify={notify}
                navigationTrigger={navigationTrigger}
              />
            ) : location.view === 'review' ? (
              <ReviewView
                tasks={data.tasks}
                waits={data.waiting_for}
                onOpenTask={openInDesk}
                onOpenWait={(wait) =>
                  updateLocation({ view: 'waiting', wait: wait.id, task: null })
                }
                questions={questions}
                pendingQuestions={data.questions.length}
                navigationTrigger={navigationTrigger}
              />
            ) : location.view === 'conversations' ? (
              <ConversationWorkspace
                chats={chats}
                messages={data.messages}
                tasks={data.tasks}
                chat={chat}
                selectedTask={selectedTask}
                sourceOnly={location.tab === 'sources'}
                selectedMessageId={location.message}
                loaded={loaded && !!config}
                onSelectChat={(id) =>
                  updateLocation({
                    chat: id,
                    task: null,
                    tab: 'overview',
                    expanded: false,
                    message: null,
                  })
                }
                onSelectTask={(task) => openTask(task, false)}
                onOpenTask={(task) => openTask(task)}
                onSourceMode={(sourceOnly) =>
                  updateLocation({ tab: sourceOnly ? 'sources' : 'overview' })
                }
                onManage={() => navigate('connections')}
                navigationTrigger={navigationTrigger}
                inspector={selectedTask || location.task ? inspector : null}
                questions={questions}
              />
            ) : location.view === 'tasks' ? (
              <TaskQueue
                tasks={data.tasks}
                loading={!loaded}
                messages={data.messages}
                chats={chats}
                location={location}
                selectedTask={selectedTask}
                syncing={data.status.syncing || requestingSync}
                search={search}
                onLocation={updateLocation}
                onSelectTask={openTask}
                onSync={() => void sync()}
                onExport={() => download('chat2tasks-export.json', JSON.stringify(data, null, 2))}
                onImport={() => file.current?.click()}
                inspector={inspector}
                questions={questions}
                navigationTrigger={navigationTrigger}
              />
            ) : location.view === 'threads' ? (
              <ThreadsPage
                onOpenTask={(task) =>
                  updateLocation({
                    view: 'tasks',
                    task: task.reference,
                    message: null,
                    expanded: false,
                  })
                }
                onOpenSource={(message) =>
                  updateLocation({
                    view: 'conversations',
                    chat: message.conversationId,
                    task: null,
                    tab: 'overview',
                    expanded: false,
                    message: message.id,
                  })
                }
              />
            ) : location.view === 'activity' ? (
              <ActivityView
                data={data}
                online={online}
                requestingSync={requestingSync}
                onSync={() => void sync()}
              />
            ) : (
              <div className="settings-shell">
                <nav className="settings-navigation" aria-label="Settings sections">
                  {settingsSections.map((section) => {
                    const selected = (location.settingsSection ?? 'models') === section.id;
                    return (
                      <button
                        key={section.id}
                        className={selected ? 'selected' : ''}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() =>
                          updateLocation({
                            view: section.id === 'conversations' ? 'connections' : 'settings',
                            settingsSection: section.id,
                          })
                        }
                      >
                        {section.label}
                      </button>
                    );
                  })}
                </nav>
                {config ? (
                  <SettingsPanel
                    section={location.settingsSection ?? 'models'}
                    config={config}
                    onSave={(next) => {
                      setConfig(next);
                      void refresh();
                    }}
                    notify={notify}
                    onImportWorkspace={
                      window.chat2tasksDesktop ? () => setWorkspaceImportOpen(true) : undefined
                    }
                  />
                ) : (
                  <p className="empty-copy">Loading settings…</p>
                )}
              </div>
            )}
            <input
              ref={file}
              type="file"
              accept=".json"
              hidden
              onChange={async (event) => {
                const input = event.target,
                  imported = input.files?.[0];
                if (!imported) return;
                try {
                  await api('import', OkSchema, JSON.parse(await imported.text()));
                  await refresh();
                  notify('Task ticks imported');
                } catch (error) {
                  notify(errorMessage(error));
                } finally {
                  input.value = '';
                }
              }}
            />
            {!taskDialogOpen && notification}
          </main>
          <Dialog.Portal>
            <Dialog.Backdrop className="modal-backdrop navigation-backdrop" />
            <Dialog.Viewport className="navigation-viewport">
              <Dialog.Popup className="navigation-popup">
                <Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
                <Dialog.Close className="icon-btn navigation-close" aria-label="Close navigation">
                  <X size={20} />
                </Dialog.Close>
                {navigation}
              </Dialog.Popup>
            </Dialog.Viewport>
          </Dialog.Portal>
        </div>
      </Dialog.Root>
      {window.chat2tasksDesktop && (
        <WorkspaceImport open={workspaceImportOpen} onOpenChange={setWorkspaceImportOpen} />
      )}
      <Dialog.Root
        open={taskDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeTask();
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="task-dialog-backdrop" />
          <Dialog.Viewport className="task-dialog-viewport">
            <Dialog.Popup
              className="task-dialog inspector"
              finalFocus={() => {
                if (taskReturnFocus.current?.element?.isConnected)
                  return taskReturnFocus.current.element;
                const row = taskReturnFocus.current
                  ? document.querySelector<HTMLElement>(
                      `[data-task-reference="${CSS.escape(taskReturnFocus.current.reference)}"]`,
                    )
                  : null;
                return (
                  row ??
                  document.querySelector<HTMLElement>(
                    '.task-search input, .thread-back, .conversation-rail-heading button',
                  )
                );
              }}
            >
              <Dialog.Title className="sr-only">Task details</Dialog.Title>
              <Dialog.Description className="sr-only">
                Review this task, its evidence, and completion criteria.
              </Dialog.Description>
              <div className="inspector-heading">
                <Dialog.Close className="text-button" aria-label="Close task details">
                  <ArrowLeft size={18} />
                  {location.view === 'conversations' ? 'Conversation' : 'Back to work'}
                </Dialog.Close>
                <span>{selectedTask?.reference ?? 'Task details'}</span>
              </div>
              {detail}
              {taskDialogOpen && notification}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

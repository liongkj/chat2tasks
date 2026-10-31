import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowLeft, Link2, Menu as MenuIcon, TriangleAlert, X } from 'lucide-react';
import { useSoundActivation } from '../shared/sound.js';
import { useNotice, type NoticeVariant } from '../shared/useNotice.js';
import { useInputModality } from '../shared/useInputModality.js';
import { SoundPreferencesSchema, type Task, type TaskEvidence } from '../shared/schema.js';
import { matchesTaskIdentifier, matchesTaskQuery } from '../shared/tasks.js';
import { api, download, OkSchema } from './api.js';
import { ConversationWorkspace } from './ConversationWorkspace.js';
import { ThreadsPage } from './ThreadsPage.js';
import { conversationName, messagesForChat, tasksForMessages } from './conversations.js';
import { ActivityView } from './Activity.js';
import { SettingsPanel } from './Settings.js';
import { TaskDetail } from './TaskDetail.js';
import { TaskQueue } from './TaskQueue.js';
import { SearchView } from './SearchView.js';
import { Overview } from './Overview.js';
import { QuestionCard } from './QuestionCard.js';
import { ReviewView } from './ReviewView.js';
import { WaitingView } from './WaitingView.js';
import { WorkspaceImport } from './WorkspaceImport.js';
import { matchesTaskFilter, tasksForDesk } from './taskDesk.js';
import { useWorkspaceLocation, type SettingsSection, type WorkspaceView } from './taskLocation.js';
import { errorMessage } from '../shared/errors.js';
import { useWorkspaceData } from './workspace/useWorkspaceData.js';
import { useNarrowLayout } from './workspace/useNarrowLayout.js';
import { useTaskTick, taskScope } from './workspace/useTaskTick.js';
import { useQuestionArrivals } from './workspace/useQuestionArrivals.js';
import { Sidebar } from './workspace/Sidebar.js';
import { Toast, type Notice } from './workspace/Toast.js';
import { viewTitle } from './workspace/viewTitle.js';

const settingsSections: { id: SettingsSection; label: string }[] = [
  { id: 'conversations', label: 'WhatsApp & chats' },
  { id: 'models', label: 'AI models' },
  { id: 'automation', label: 'Automation' },
  { id: 'attention', label: 'Attention' },
  { id: 'workspace', label: 'Workspaces' },
  { id: 'browser', label: 'Browser' },
];

export function App() {
  useInputModality();
  useSoundActivation();
  const narrow = useNarrowLayout();
  const { location, updateLocation } = useWorkspaceLocation();
  const workspace = useWorkspaceData();
  const {
    data,
    setData,
    config,
    setConfig,
    configError,
    loaded,
    online,
    requestingSync,
    setRequestingSync,
    refresh,
    refreshConfig,
    refreshGate,
    pendingTicks,
    pendingTickIds,
  } = workspace;
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const {
    notice,
    exiting: noticeExiting,
    show: showNotice,
    dismiss: dismissNotice,
  } = useNotice<Notice>();
  const notify = useCallback(
    (text: string, variant: NoticeVariant = 'info') =>
      showNotice({ kind: 'message', text, variant }),
    [showNotice],
  );
  const [mobileMenu, setMobileMenu] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const taskReturnFocus = useRef<{
    element: HTMLElement | null;
    reference: Task['reference'];
  } | null>(null);
  const initialized = useRef<string | null>(null);
  const restoredSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    // Leave time to read and reach Undo when it is offered.
    const timer = setTimeout(dismissNotice, notice.kind === 'completion' ? 10000 : 7000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);
  const chats = config?.settings.chats ?? [];
  const chat = chats.find((item) => item.id === location.chat);
  const selectedTask = data.tasks.find((task) => matchesTaskIdentifier(task, location.task));
  const newQuestions = useQuestionArrivals(data, loaded, location, chat);
  const { tick, completionFlash, celebrationScope } = useTaskTick({
    workspace,
    location,
    chats,
    notify,
    showCompletion: showNotice,
  });
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
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setMobileMenu(false);
        document.querySelector<HTMLInputElement>('input[aria-label="Search workspace"]')?.focus();
        updateLocation({ view: 'search', task: null, message: null, chat: null, query: '' });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [updateLocation]);
  const title = viewTitle(location);
  useEffect(() => {
    document.title = `Wawa — ${chat && location.view === 'conversations' ? chat.name : title}`;
  }, [title, chat, location.view]);
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
      notify(errorMessage(error), 'error');
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
      completionConfirmed={completionFlash === selectedTask.id}
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
    <Sidebar
      data={data}
      loaded={loaded}
      online={online}
      chats={chats}
      location={location}
      onNavigate={navigate}
      onLocation={(patch) => {
        setMobileMenu(false);
        updateLocation(patch);
      }}
    />
  );
  const navigationTrigger = (
    <Dialog.Trigger className="icon-btn mobile-toggle" aria-label="Open navigation">
      <MenuIcon size={21} />
    </Dialog.Trigger>
  );
  const taskDialogOpen =
    narrow && !!location.task && (location.view === 'tasks' || location.expanded);
  const undoTask =
    notice?.kind === 'completion'
      ? data.tasks.find((task) => task.id === notice.taskId)
      : undefined;
  const notification = notice && (
    <Toast
      notice={notice}
      exiting={noticeExiting}
      undoTask={undoTask}
      undoBusy={notice.kind === 'completion' && pendingTickIds.has(notice.taskId)}
      onUndo={(task, previousDone) => void tick(task, previousDone, 'undo')}
      onDismiss={dismissNotice}
    />
  );
  const questions = data.questions
    .filter((question) => {
      if (location.view !== 'conversations') return true;
      const message = data.messages.find((item) => item.id === question.message_id);
      return chat && message?.chatId === chat.chatId && message.sessionId === chat.sessionId;
    })
    .map((question) => (
      <QuestionCard
        key={question.id}
        question={question}
        messages={data.messages}
        tasks={data.tasks}
        arrived={newQuestions.has(question.id)}
        notify={notify}
        refresh={refresh}
      />
    ));
  return (
    <>
      <Dialog.Root open={mobileMenu} onOpenChange={setMobileMenu}>
        <div className="app">
          <aside className="sidebar">{navigation}</aside>
          <main className="workspace">
            {location.view !== 'search' &&
              location.view !== 'conversations' &&
              location.view !== 'tasks' &&
              location.view !== 'overview' &&
              location.view !== 'waiting' &&
              location.view !== 'review' && (
                <header className="topbar">
                  {navigationTrigger}
                  <span>{title}</span>
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
            {location.view === 'search' ? (
              <SearchView
                tasks={data.tasks}
                messages={data.messages}
                chats={chats}
                query={workspaceQuery}
                onQuery={setWorkspaceQuery}
                onTask={openInDesk}
                onMessage={(message, targetChat) =>
                  updateLocation({
                    view: 'conversations',
                    chat: targetChat.id,
                    message: message.id,
                    task: null,
                    tab: 'overview',
                    expanded: false,
                  })
                }
                navigationTrigger={navigationTrigger}
              />
            ) : location.view === 'overview' ? (
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
                onExport={() => download('wawa-export.json', JSON.stringify(data, null, 2))}
                onImport={() => file.current?.click()}
                inspector={inspector}
                questions={questions}
                celebrate={celebrationScope === taskScope(location)}
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
                    sound={data.sound}
                    onSoundSave={async (value) => {
                      const saved = await api('sound-preferences', SoundPreferencesSchema, value);
                      refreshGate.current.invalidate();
                      setData((current) => ({ ...current, sound: saved }));
                    }}
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
                  notify(errorMessage(error), 'error');
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

import { Menu } from '@base-ui/react/menu';
import {
  ArrowDownToLine,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  MoreHorizontal,
  Search,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';
import type { Chat, Message, Task } from '../shared/schema.js';
import { conversationName, stateLabel } from './conversations.js';
import { matchesTaskQuery } from '../shared/tasks.js';
import type { WorkspaceLocation } from './taskLocation.js';

export function TaskQueue({
  tasks,
  messages,
  chats,
  location,
  selectedTask,
  pending,
  syncing,
  search,
  onLocation,
  onSelectTask,
  onTick,
  onSync,
  onExport,
  onImport,
  inspector,
  questions,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  location: WorkspaceLocation;
  selectedTask: Task | undefined;
  pending: Set<string>;
  syncing: boolean;
  search: RefObject<HTMLInputElement | null>;
  onLocation: (patch: Partial<WorkspaceLocation>, options?: { replace?: boolean }) => void;
  onSelectTask: (task: Task) => void;
  onTick: (task: Task) => void;
  onSync: () => void;
  onExport: () => void;
  onImport: () => void;
  inspector: ReactNode;
  questions: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const selectedChat = chats.find((chat) => chat.id === location.chat);
  const ids = new Set(
    messages
      .filter(
        (message) =>
          !selectedChat ||
          (selectedChat.chatId === message.chatId && selectedChat.sessionId === message.sessionId),
      )
      .map((message) => message.id),
  );
  const visible = tasks
    .filter(
      (task) =>
        (!selectedChat || task.source_ids.some((id) => ids.has(id))) &&
        (location.filter === 'all' || task.done === (location.filter === 'done')) &&
        matchesTaskQuery(task, location.query),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.priority === 'high') - Number(a.priority === 'high') ||
        b.updated - a.updated,
    );
  const filters: WorkspaceLocation['filter'][] = ['open', 'done', 'all'];
  const groups = [
    ...(['ready', 'needs_info', 'waiting', 'reported_done'] satisfies Task['triage_state'][]).map(
      (group) => ({
        key: group,
        label: stateLabel[group],
        tasks: visible.filter((task) => !task.done && task.triage_state === group),
      }),
    ),
    { key: 'completed', label: 'Completed', tasks: visible.filter((task) => task.done) },
  ];
  return (
    <div className={`task-layout ${selectedTask || location.task ? 'with-selection' : ''}`}>
      <section className="task-column">
        <div className="page-heading">
          <div>
            <span className="eyebrow">A little clarity, a little momentum.</span>
            <h1>All tasks</h1>
          </div>
          <span className="open-task-count">{tasks.filter((task) => !task.done).length} open</span>
        </div>
        <div className="task-toolbar">
          <label className="task-search">
            <Search size={17} />
            <input
              ref={search}
              aria-label="Search tasks"
              placeholder="Find a task or TODO number…"
              value={location.query}
              onChange={(event) =>
                onLocation(
                  { query: event.target.value, task: null, tab: 'overview' },
                  { replace: true },
                )
              }
            />
            <kbd>⌘ K</kbd>
          </label>
          <div className="queue-controls">
            <div className="tabs" role="tablist" aria-label="Task status">
              {filters.map((filter) => (
                <button
                  key={filter}
                  role="tab"
                  aria-selected={location.filter === filter}
                  tabIndex={location.filter === filter ? 0 : -1}
                  data-filter={filter}
                  onClick={() => onLocation({ filter, task: null })}
                  onKeyDown={(event) => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                      event.preventDefault();
                      const offset = event.key === 'ArrowLeft' ? -1 : 1;
                      const next =
                        event.key === 'Home'
                          ? 'open'
                          : event.key === 'End'
                            ? 'all'
                            : filters[
                                (filters.indexOf(filter) + offset + filters.length) % filters.length
                              ];
                      if (!next) return;
                      onLocation({ filter: next, task: null });
                      event.currentTarget.parentElement
                        ?.querySelector<HTMLButtonElement>(`button[data-filter="${next}"]`)
                        ?.focus();
                    }
                  }}
                >
                  {filter === 'open' ? 'Open' : filter === 'done' ? 'Completed' : 'All'}
                </button>
              ))}
            </div>
            <select
              aria-label="Filter by conversation"
              value={location.chat ?? ''}
              onChange={(event) => onLocation({ chat: event.target.value || null, task: null })}
            >
              <option value="">All conversations</option>
              {chats.map((chat) => (
                <option key={chat.id} value={chat.id}>
                  {chat.name}
                </option>
              ))}
            </select>
            <Menu.Root open={menu} onOpenChange={setMenu}>
              <Menu.Trigger className="icon-btn" aria-label="More task actions">
                <MoreHorizontal size={18} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner className="menu-positioner" sideOffset={6} align="end">
                  <Menu.Popup className="popover">
                    <Menu.Item
                      disabled={syncing}
                      onClick={() => {
                        onSync();
                        setMenu(false);
                      }}
                    >
                      <Zap size={15} /> Find tasks now
                    </Menu.Item>
                    <Menu.Item
                      onClick={() => {
                        onLocation({ filter: 'all' });
                        setMenu(false);
                      }}
                    >
                      Show all tasks
                    </Menu.Item>
                    <Menu.Item onClick={onExport}>
                      <ArrowDownToLine size={15} /> Export workspace
                    </Menu.Item>
                    <Menu.Item onClick={onImport}>
                      <FileText size={15} /> Import task ticks
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
        {questions}
        <div className="task-list">
          {groups.map((group) => {
            const groupTasks = group.tasks;
            return groupTasks.length ? (
              <div className="task-group" key={group.key}>
                <div className="group-heading">
                  <h2>{group.label}</h2>
                  <span>{groupTasks.length}</span>
                </div>
                {groupTasks.map((task) => (
                  <div
                    key={task.id}
                    className={`task-row ${selectedTask?.id === task.id ? 'selected' : ''} ${task.done ? 'done' : ''}`}
                  >
                    <button
                      className="check-button"
                      aria-label={`${task.done ? 'Reopen' : 'Complete'}: ${task.title}`}
                      aria-pressed={task.done}
                      disabled={pending.has(task.id)}
                      onClick={() => onTick(task)}
                    >
                      {task.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                    </button>
                    <button
                      className="task-row-content"
                      data-task-reference={task.reference}
                      aria-label={`Open task: ${task.title}`}
                      onClick={() => onSelectTask(task)}
                    >
                      <span className="task-title">{task.title}</span>
                      <span className="task-row-sub">
                        <span className="task-reference">{task.reference}</span>
                        <span aria-hidden="true">·</span>
                        <span>{conversationName(task, messages, chats)}</span>
                        {task.priority === 'high' && (
                          <span className="priority-label">High priority</span>
                        )}
                      </span>
                    </button>
                    <ChevronRight size={15} className="row-chevron" />
                  </div>
                ))}
              </div>
            ) : null;
          })}
          {!visible.length && (
            <div className="empty-state">
              <CheckCircle2 size={28} />
              <h2>
                {location.query
                  ? 'No matching tasks'
                  : location.filter === 'done'
                    ? 'No completed tasks here yet'
                    : 'You’re all caught up here.'}
              </h2>
              <p>
                {location.query
                  ? 'Try a different word, task reference, or conversation.'
                  : 'Your conversations and their evidence remain available.'}
              </p>
            </div>
          )}
        </div>
      </section>
      {inspector}
    </div>
  );
}

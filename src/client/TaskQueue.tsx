import { Menu } from '@base-ui/react/menu';
import {
  ArrowDownToLine,
  CheckCircle2,
  FileText,
  MoreHorizontal,
  Search,
  X,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode, type RefObject } from 'react';
import type { Chat, Message, Task } from '../shared/schema.js';
import { itemKindLabel } from '../shared/tasks.js';
import { conversationName } from './conversations.js';
import { deskTitle, tasksForDesk } from './taskDesk.js';
import { TaskState } from './TaskDetail.js';
import type { WorkspaceLocation } from './taskLocation.js';

export function TaskQueue({
  tasks,
  messages,
  chats,
  location,
  selectedTask,
  loading,
  syncing,
  search,
  onLocation,
  onSelectTask,
  onSync,
  onExport,
  onImport,
  inspector,
  questions,
  navigationTrigger,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  location: WorkspaceLocation;
  selectedTask: Task | undefined;
  loading: boolean;
  syncing: boolean;
  search: RefObject<HTMLInputElement | null>;
  onLocation: (patch: Partial<WorkspaceLocation>, options?: { replace?: boolean }) => void;
  onSelectTask: (task: Task) => void;
  onSync: () => void;
  onExport: () => void;
  onImport: () => void;
  inspector: ReactNode;
  questions: ReactNode;
  navigationTrigger: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const selectedChat = chats.find((chat) => chat.id === location.chat);
  const visible = tasksForDesk({ tasks, messages, chats, location });
  return (
    <div className="task-layout">
      <section className="task-column" aria-label="Task queue">
        <div className="page-heading">
          {navigationTrigger}
          <h1>{deskTitle(location)}</h1>
          <span
            className="open-task-count"
            aria-label={loading ? 'Loading items' : `${visible.length} items in this view`}
          >
            {loading ? '…' : visible.length}
          </span>
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
                    <Zap size={15} />
                    Find tasks now
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => {
                      onLocation({
                        filter: 'all',
                        kind: 'all',
                        chat: null,
                        query: '',
                        task: null,
                        tab: 'overview',
                        expanded: false,
                      });
                      setMenu(false);
                    }}
                  >
                    Show all items
                  </Menu.Item>
                  <Menu.Item onClick={onExport}>
                    <ArrowDownToLine size={15} />
                    Export workspace
                  </Menu.Item>
                  <Menu.Item onClick={onImport}>
                    <FileText size={15} />
                    Import task ticks
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
        <div className="task-toolbar">
          <label className="task-search">
            <Search size={16} />
            <input
              ref={search}
              aria-label="Search tasks"
              placeholder="Search tasks"
              value={location.query}
              onChange={(event) =>
                onLocation(
                  { query: event.target.value, task: null, tab: 'overview', expanded: false },
                  { replace: true },
                )
              }
            />
            {location.query ? (
              <button
                className="icon-btn"
                aria-label="Clear search"
                onClick={() =>
                  onLocation(
                    { query: '', task: null, tab: 'overview', expanded: false },
                    { replace: true },
                  )
                }
              >
                <X size={14} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </label>
        </div>
        <div className="queue-context">
          <span>{selectedChat?.name ?? 'Across all conversations'}</span>
          <span>Priority first</span>
        </div>
        {questions}
        <div className="task-list">
          {visible.map((task) => (
            <div
              key={task.id}
              className={`task-row ${selectedTask?.id === task.id ? 'selected' : ''} ${task.done ? 'done' : ''}`}
            >
              <button
                className="task-row-content"
                data-task-reference={task.reference}
                aria-label={`Open ${itemKindLabel[task.kind].toLowerCase()}: ${task.title}`}
                aria-pressed={selectedTask?.id === task.id}
                onClick={() => onSelectTask(task)}
              >
                <span className="task-row-meta">
                  <span className="task-reference">{task.reference}</span>
                  <span className="item-kind">{itemKindLabel[task.kind]}</span>
                  <TaskState task={task} />
                  {task.kind_suggestion && <span className="item-kind-review">Check category</span>}
                </span>
                <span className="task-title">{task.title}</span>
                <span className="task-row-sub">
                  <span>{conversationName(task, messages, chats)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {task.priority === 'high'
                      ? 'High priority'
                      : `${task.source_ids.length} linked ${task.source_ids.length === 1 ? 'message' : 'messages'}`}
                  </span>
                </span>
              </button>
            </div>
          ))}
          {loading && (
            <p className="empty-copy" role="status">
              Loading tasks…
            </p>
          )}
          {!loading && !visible.length && (
            <div className="empty-state">
              <CheckCircle2 size={28} />
              <h2>
                {location.query
                  ? 'No matching tasks'
                  : location.filter === 'done'
                    ? 'No completed tasks here yet'
                    : 'No open tasks here'}
              </h2>
              <p>
                {location.query
                  ? 'Try another title, TODO reference, or conversation.'
                  : 'Choose another filter or browse your saved conversations.'}
              </p>
            </div>
          )}
        </div>
      </section>
      {inspector}
    </div>
  );
}

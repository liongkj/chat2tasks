import {
  Bell,
  CheckCheck,
  Circle,
  CircleAlert,
  Clock3,
  CalendarDays,
  BriefcaseBusiness,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Sparkles,
  Inbox,
  MessageCircle,
  SquareCheck,
} from 'lucide-react';
import type { Chat, Message, Task, Wait } from '../shared/schema.js';
import { tasksForDesk } from './taskDesk.js';
import type { ItemKindFilter, TaskFilter, WorkspaceLocation } from './taskLocation.js';

const kinds = [
  { value: 'all', label: 'All items', icon: Inbox },
  { value: 'task', label: 'Tasks', icon: SquareCheck },
  { value: 'action', label: 'Actions', icon: ListChecks },
  { value: 'question', label: 'Questions', icon: MessageCircle },
  { value: 'reminder', label: 'Reminders', icon: Bell },
  { value: 'upcoming', label: 'Upcoming', icon: CalendarDays },
  { value: 'someday', label: 'Someday / Maybe', icon: Sparkles },
  { value: 'projects', label: 'Projects', icon: FolderKanban },
  { value: 'areas', label: 'Areas', icon: BriefcaseBusiness },
  { value: 'event', label: 'Events', icon: CalendarDays },
  { value: 'reference', label: 'Reference', icon: FileText },
] satisfies { value: ItemKindFilter; label: string; icon: typeof Inbox }[];

const filters = [
  { value: 'open', label: 'All open work', icon: Inbox },
  { value: 'needs_info', label: 'Needs information', icon: CircleAlert },
  { value: 'ready', label: 'Ready', icon: Circle },
  { value: 'waiting', label: 'Waiting', icon: Clock3 },
  { value: 'reported_done', label: 'Reported done', icon: CheckCheck },
  { value: 'done', label: 'Completed', icon: SquareCheck },
] satisfies { value: TaskFilter; label: string; icon: typeof Inbox }[];

export function TaskFilters({
  tasks,
  messages,
  chats,
  waits,
  pendingQuestions,
  location,
  loaded,
  onLocation,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  waits: Wait[];
  pendingQuestions: number;
  location: WorkspaceLocation;
  loaded: boolean;
  onLocation: (patch: Partial<WorkspaceLocation>) => void;
}) {
  const context: WorkspaceLocation =
    location.view === 'tasks'
      ? location
      : { ...location, kind: 'all', filter: 'open', chat: null, query: '' };
  const choose = (patch: Pick<WorkspaceLocation, 'filter' | 'chat' | 'query' | 'kind'>) =>
    onLocation({ view: 'tasks', task: null, tab: 'overview', expanded: false, ...patch });
  return (
    <div className="task-navigation">
      <nav aria-label="Item categories">
        <p className="nav-section-label">Categories</p>
        <button
          className={`nav-item ${location.view === 'overview' ? 'active' : ''}`}
          aria-pressed={location.view === 'overview'}
          onClick={() => onLocation({ view: 'overview', task: null, wait: null })}
        >
          <LayoutDashboard size={16} />
          <span>Overview</span>
        </button>
        {kinds
          .filter(({ value }) => ['all', 'task', 'action', 'question', 'reminder'].includes(value))
          .map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={`nav-item ${location.view === 'tasks' && location.kind === value ? 'active' : ''}`}
              aria-pressed={location.view === 'tasks' && location.kind === value}
              onClick={() =>
                choose({ kind: value, filter: 'open', chat: context.chat, query: context.query })
              }
            >
              <Icon size={16} />
              <span>{label}</span>
              <span className="nav-count" aria-hidden="true">
                {loaded
                  ? tasksForDesk({
                      tasks,
                      messages,
                      chats,
                      location: { ...context, kind: value, filter: 'open' },
                    }).length
                  : '…'}
              </span>
            </button>
          ))}
        <button
          className={`nav-item ${location.view === 'waiting' ? 'active' : ''}`}
          aria-pressed={location.view === 'waiting'}
          onClick={() => onLocation({ view: 'waiting', task: null, wait: null })}
        >
          <Clock3 size={16} />
          <span>Waiting for</span>
          <span className="nav-count" aria-hidden="true">
            {loaded
              ? waits.filter((wait) => wait.state === 'waiting' && !wait.needs_review).length
              : '…'}
          </span>
        </button>
        <button
          className={`nav-item ${location.view === 'review' ? 'active' : ''}`}
          aria-pressed={location.view === 'review'}
          onClick={() => onLocation({ view: 'review', task: null, wait: null })}
        >
          <CircleAlert size={16} />
          <span>Review</span>
          <span className="nav-count" aria-hidden="true">
            {loaded
              ? tasks.filter((task) => !task.done && task.kind_suggestion).length +
                waits.filter((wait) => wait.state === 'waiting' && wait.needs_review).length +
                pendingQuestions
              : '…'}
          </span>
        </button>
      </nav>
      <nav aria-label="More views">
        <p className="nav-section-label">Organize</p>
        {kinds
          .filter(({ value }) =>
            ['upcoming', 'someday', 'projects', 'areas', 'event', 'reference'].includes(value),
          )
          .map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={`nav-item ${location.view === 'tasks' && location.kind === value ? 'active' : ''}`}
              aria-pressed={location.view === 'tasks' && location.kind === value}
              onClick={() =>
                choose({ kind: value, filter: 'open', chat: context.chat, query: context.query })
              }
            >
              <Icon size={16} />
              <span>{label}</span>
              <span className="nav-count" aria-hidden="true">
                {loaded
                  ? tasksForDesk({
                      tasks,
                      messages,
                      chats,
                      location: { ...context, kind: value, filter: 'open' },
                    }).length
                  : '…'}
              </span>
            </button>
          ))}
      </nav>
      <nav aria-label="Task filters">
        <p className="nav-section-label">Status</p>
        {filters.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            className={`nav-item ${location.view === 'tasks' && location.filter === value ? 'active' : ''}`}
            aria-label={label}
            aria-pressed={location.view === 'tasks' && location.filter === value}
            onClick={() =>
              choose({
                filter: value,
                kind: context.kind,
                chat: context.chat,
                query: context.query,
              })
            }
          >
            <Icon size={16} />
            <span>{label}</span>
            <span className="nav-count" aria-hidden="true">
              {loaded
                ? tasksForDesk({ tasks, messages, chats, location: { ...context, filter: value } })
                    .length
                : '…'}
            </span>
          </button>
        ))}
      </nav>
      <nav aria-label="Conversation filters" className="conversation-filters">
        <p className="nav-section-label">Conversations</p>
        <button
          className={`conversation-filter ${location.view === 'tasks' && !location.chat ? 'active' : ''}`}
          aria-pressed={location.view === 'tasks' && !location.chat}
          onClick={() =>
            choose({ filter: context.filter, kind: context.kind, chat: null, query: context.query })
          }
        >
          All conversations
        </button>
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`conversation-filter ${location.view === 'tasks' && location.chat === chat.id ? 'active' : ''}`}
            aria-label={`Filter tasks from ${chat.name}`}
            aria-pressed={location.view === 'tasks' && location.chat === chat.id}
            onClick={() =>
              choose({
                filter: context.filter,
                kind: context.kind,
                chat: chat.id,
                query: context.query,
              })
            }
          >
            {chat.name}
          </button>
        ))}
      </nav>
    </div>
  );
}

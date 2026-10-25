import { CheckCheck, Circle, CircleAlert, Clock3, Inbox, SquareCheck } from 'lucide-react';
import type { Chat, Message, Task } from '../shared/schema.js';
import { tasksForDesk } from './taskDesk.js';
import type { TaskFilter, WorkspaceLocation } from './taskLocation.js';

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
  location,
  loaded,
  onLocation,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  location: WorkspaceLocation;
  loaded: boolean;
  onLocation: (patch: Partial<WorkspaceLocation>) => void;
}) {
  const context = location.view === 'tasks' ? location : { ...location, chat: null, query: '' };
  const choose = (patch: Pick<WorkspaceLocation, 'filter' | 'chat' | 'query'>) =>
    onLocation({ view: 'tasks', task: null, tab: 'overview', expanded: false, ...patch });
  return (
    <div className="task-navigation">
      <nav aria-label="Task filters">
        <p className="nav-section-label">Workspace</p>
        {filters.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            className={`nav-item ${location.view === 'tasks' && location.filter === value ? 'active' : ''}`}
            aria-label={label}
            aria-pressed={location.view === 'tasks' && location.filter === value}
            onClick={() => choose({ filter: value, chat: context.chat, query: context.query })}
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
          onClick={() => choose({ filter: context.filter, chat: null, query: context.query })}
        >
          All conversations
        </button>
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`conversation-filter ${location.view === 'tasks' && location.chat === chat.id ? 'active' : ''}`}
            aria-label={`Filter tasks from ${chat.name}`}
            aria-pressed={location.view === 'tasks' && location.chat === chat.id}
            onClick={() => choose({ filter: context.filter, chat: chat.id, query: context.query })}
          >
            {chat.name}
          </button>
        ))}
      </nav>
    </div>
  );
}

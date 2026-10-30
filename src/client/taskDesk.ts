import type { Chat, Message, Task } from '../shared/schema.js';
import { itemKindPlural, matchesTaskQuery } from '../shared/tasks.js';
import { messagesForChat, stateLabel, tasksForMessages } from './conversations.js';
import type { TaskFilter, WorkspaceLocation } from './taskLocation.js';

export const taskFilterLabel = {
  open: 'Open work',
  all: 'All items',
  done: 'Completed',
  ...stateLabel,
} satisfies Record<TaskFilter, string>;

export function deskTitle(location: Pick<WorkspaceLocation, 'filter' | 'kind'>) {
  if (location.kind === 'all') return taskFilterLabel[location.filter];
  const name = itemKindPlural[location.kind];
  if (location.filter === 'open') return name;
  if (location.filter === 'done') return `Completed ${name.toLowerCase()}`;
  if (location.filter === 'all') return `All ${name.toLowerCase()}`;
  return `${name} · ${taskFilterLabel[location.filter]}`;
}

export function matchesTaskFilter(task: Task, filter: TaskFilter) {
  if (filter === 'all') return true;
  if (filter === 'done') return task.done;
  return !task.done && (filter === 'open' || task.triage_state === filter);
}

export function tasksForDesk({
  tasks,
  messages,
  chats,
  location,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  location: Pick<WorkspaceLocation, 'filter' | 'chat' | 'query' | 'kind'>;
}) {
  const chat = chats.find((item) => item.id === location.chat);
  const scoped = chat ? tasksForMessages(tasks, messagesForChat(chat, messages)) : tasks;
  return scoped
    .filter(
      (task) =>
        matchesTaskFilter(task, location.filter) &&
        (location.kind === 'all' || task.kind === location.kind) &&
        matchesTaskQuery(task, location.query),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.priority === 'high') - Number(a.priority === 'high') ||
        b.updated - a.updated,
    );
}

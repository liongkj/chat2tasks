import type { Chat, Message, Task } from '../shared/schema.js';
import { matchesTaskQuery } from '../shared/tasks.js';
import { messagesForChat, stateLabel, tasksForMessages } from './conversations.js';
import type { TaskFilter, WorkspaceLocation } from './taskLocation.js';

export const taskFilterLabel = {
  open: 'Open work',
  all: 'All tasks',
  done: 'Completed',
  ...stateLabel,
} satisfies Record<TaskFilter, string>;

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
  location: Pick<WorkspaceLocation, 'filter' | 'chat' | 'query'>;
}) {
  const chat = chats.find((item) => item.id === location.chat);
  const scoped = chat ? tasksForMessages(tasks, messagesForChat(chat, messages)) : tasks;
  return scoped
    .filter(
      (task) => matchesTaskFilter(task, location.filter) && matchesTaskQuery(task, location.query),
    )
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        Number(b.priority === 'high') - Number(a.priority === 'high') ||
        b.updated - a.updated,
    );
}

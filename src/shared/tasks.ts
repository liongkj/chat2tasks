import type { ItemKind, Task } from './schema.js';

export const itemKindLabel = {
  task: 'Task',
  action: 'Action',
  question: 'Question',
  reminder: 'Reminder',
  event: 'Event',
  reference: 'Reference',
} satisfies Record<ItemKind, string>;

export const itemKindPlural = {
  task: 'Tasks',
  action: 'Actions',
  question: 'Questions',
  reminder: 'Reminders',
  event: 'Events',
  reference: 'Reference',
} satisfies Record<ItemKind, string>;

export function isUpcoming(item: Pick<Task, 'kind' | 'gtd'>, today = localDate()) {
  if (item.gtd.commitment !== 'active') return false;
  if (item.gtd.recurrence) return true;
  return item.gtd.times.some(
    (time) => item.kind !== 'event' || time.date === null || time.date >= today,
  );
}

function localDate() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

export function matchesTaskIdentifier(task: Task, identifier: string | null) {
  return (
    identifier !== null &&
    [task, ...task.merged_from].some(
      (item) => item.id === identifier || item.reference === identifier.toUpperCase(),
    )
  );
}

export function matchesTaskQuery(task: Task, query: string) {
  return [
    task.reference,
    task.title,
    task.scope,
    task.note,
    task.own_remark,
    ...task.merged_from.flatMap((source) => [
      source.reference,
      source.title,
      source.note,
      source.own_remark,
    ]),
  ]
    .join(' ')
    .toLowerCase()
    .includes(query.toLowerCase());
}

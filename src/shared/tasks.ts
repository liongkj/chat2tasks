import type { Task } from './schema.js';

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

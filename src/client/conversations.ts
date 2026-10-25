import type { Chat, Message, Task } from '../shared/schema.js';

export const stateLabel = {
  ready: 'Ready',
  waiting: 'Waiting',
  needs_info: 'Needs information',
  reported_done: 'Reported done',
} satisfies Record<Task['triage_state'], string>;

export function messagesForChat(chat: Chat, messages: Message[]) {
  return messages
    .filter((message) => message.chatId === chat.chatId && message.sessionId === chat.sessionId)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

export function tasksForMessages(tasks: Task[], messages: Message[]) {
  const ids = new Set(messages.map((message) => message.id));
  return tasks.filter((task) => task.source_ids.some((id) => ids.has(id)));
}

export function conversationName(task: Task, messages: Message[], chats: Chat[]) {
  const sources = messages.filter((message) => task.source_ids.includes(message.id));
  const conversations = new Set(
    sources.map((message) => `${message.sessionId}\0${message.chatId}`),
  );
  if (conversations.size > 1) return `${conversations.size} conversations`;
  const source = sources[0];
  return (
    chats.find((chat) => chat.chatId === source?.chatId && chat.sessionId === source.sessionId)
      ?.name ?? task.scope
  );
}

export function clockTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    timestamp * 1000,
  );
}

export function dayLabel(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return (
    (sameDay ? 'Today · ' : '') +
    new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date)
  );
}

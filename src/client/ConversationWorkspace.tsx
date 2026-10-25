import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import type { Chat, Message, Task } from '../shared/schema.js';
import { clockTime, dayLabel, messagesForChat, tasksForMessages } from './conversations.js';
import { MessageCard } from './Evidence.js';
import { TaskState } from './TaskDetail.js';

export function ConversationWorkspace({
  chats,
  messages,
  tasks,
  chat,
  selectedTask,
  sourceOnly,
  loaded,
  onSelectChat,
  onSelectTask,
  onOpenTask,
  onSourceMode,
  onManage,
  navigationTrigger,
  inspector,
  questions,
}: {
  chats: Chat[];
  messages: Message[];
  tasks: Task[];
  chat: Chat | undefined;
  selectedTask: Task | undefined;
  sourceOnly: boolean;
  loaded: boolean;
  onSelectChat: (id: string | null) => void;
  onSelectTask: (task: Task) => void;
  onOpenTask: (task: Task) => void;
  onSourceMode: (sourceOnly: boolean) => void;
  onManage: () => void;
  navigationTrigger: ReactNode;
  inspector: ReactNode;
  questions: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const thread = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const previousChat = useRef<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const chatMessages = chat ? messagesForChat(chat, messages) : [];
  const relatedTasks = tasksForMessages(tasks, chatMessages);
  const annotations = new Map<string, Task[]>();
  for (const task of relatedTasks) {
    const lastSource = chatMessages
      .filter((message) => task.source_ids.includes(message.id))
      .at(-1);
    if (lastSource)
      annotations.set(lastSource.id, [...(annotations.get(lastSource.id) ?? []), task]);
  }
  const selectedIds = new Set(selectedTask?.source_ids ?? []);
  const visibleMessages =
    sourceOnly && selectedTask
      ? chatMessages.filter((message) => selectedIds.has(message.id))
      : chatMessages;
  const latest = chatMessages.at(-1);
  useEffect(() => {
    if (!chat && previousChat.current) rows.current.get(previousChat.current)?.focus();
    if (chat && window.matchMedia('(max-width: 900px)').matches) back.current?.focus();
    previousChat.current = chat?.id ?? null;
  }, [chat?.id]);
  useEffect(() => {
    if (!selectedTask) return;
    const linked = [
      ...(thread.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []),
    ].find((element) => selectedTask.source_ids.includes(element.dataset.messageId ?? ''));
    linked?.scrollIntoView({ block: 'center' });
  }, [chat?.id, selectedTask?.id, sourceOnly]);
  return (
    <div className={`conversation-layout ${chat ? 'conversation-open' : ''}`}>
      <section className="conversation-rail" aria-label="Followed conversations">
        <div className="conversation-rail-heading">
          {navigationTrigger}
          <h1>Conversations</h1>
          <button className="add-conversation" aria-label="Manage conversations" onClick={onManage}>
            <Plus size={19} />
          </button>
        </div>
        <label className="conversation-search">
          <Search size={15} />
          <input
            aria-label="Find a conversation"
            placeholder="Find a conversation"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="conversation-list">
          {chats
            .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
            .map((item) => {
              const saved = messagesForChat(item, messages);
              const recent = saved.at(-1);
              const open = tasksForMessages(tasks, saved).filter((task) => !task.done).length;
              return (
                <button
                  key={item.id}
                  ref={(element) => {
                    if (element) rows.current.set(item.id, element);
                    else rows.current.delete(item.id);
                  }}
                  className={`conversation-row ${chat?.id === item.id ? 'selected' : ''}`}
                  aria-label={`Open conversation: ${item.name}`}
                  aria-current={chat?.id === item.id ? 'true' : undefined}
                  onClick={() => onSelectChat(item.id)}
                >
                  <span className="conversation-row-top">
                    <strong>{item.name}</strong>
                    <time>
                      {recent?.timestamp
                        ? new Date(recent.timestamp * 1000).toDateString() ===
                          new Date().toDateString()
                          ? clockTime(recent.timestamp)
                          : new Intl.DateTimeFormat(undefined, {
                              month: 'short',
                              day: 'numeric',
                            }).format(recent.timestamp * 1000)
                        : ''}
                    </time>
                  </span>
                  <span className="conversation-row-bottom">
                    <span>
                      {!item.enabled ? 'Paused · ' : ''}
                      {recent
                        ? recent.body || `${recent.type} attachment`
                        : 'No saved messages yet'}
                    </span>
                    {open > 0 && (
                      <span className="conversation-count" aria-label={`${open} open tasks`}>
                        {open}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          {loaded && !chats.length && (
            <div className="rail-empty">
              <MessageCircle size={25} />
              <h2>A conversation is a good start.</h2>
              <p>Follow a chat to keep its messages and next steps together.</p>
              <button className="button primary" onClick={onManage}>
                Connect your first chat
              </button>
            </div>
          )}
          {chats.length > 0 &&
            !chats.some((item) => item.name.toLowerCase().includes(query.toLowerCase())) && (
              <p className="empty-copy">No conversations match your search.</p>
            )}
          {!loaded && (
            <p className="empty-copy" role="status">
              Loading conversations…
            </p>
          )}
        </div>
        <button className="rail-manage text-button" onClick={onManage}>
          <Settings2 size={15} /> Manage connections
        </button>
      </section>
      <section
        className="conversation-thread"
        aria-label={chat ? `Saved messages: ${chat.name}` : 'Saved messages'}
      >
        {chat ? (
          <>
            <header className="thread-heading">
              <button
                className="icon-btn thread-back"
                aria-label="Back to conversations"
                ref={back}
                onClick={() => onSelectChat(null)}
              >
                <ArrowLeft size={20} />
              </button>
              <MessageCircle size={25} className="thread-icon" />
              <div>
                <h2>{chat.name}</h2>
                <p>{chat.enabled ? 'Saved conversation' : 'Paused conversation'}</p>
              </div>
              <Menu.Root>
                <Menu.Trigger className="icon-btn" aria-label="More conversation actions">
                  <MoreHorizontal size={19} />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner className="menu-positioner" sideOffset={6} align="end">
                    <Menu.Popup className="popover">
                      {selectedTask && (
                        <Menu.Item onClick={() => onSourceMode(!sourceOnly)}>
                          <Link2 size={15} />
                          {sourceOnly ? 'Show all messages' : 'Show task evidence'}
                        </Menu.Item>
                      )}
                      <Menu.Item onClick={onManage}>
                        <Settings2 size={15} /> Manage conversation
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            </header>
            <div className="thread-tools">
              <span>
                {latest?.timestamp
                  ? `Latest message ${clockTime(latest.timestamp)}`
                  : 'No saved messages yet'}
              </span>
              {selectedTask && (
                <button
                  className="text-button"
                  aria-pressed={sourceOnly}
                  onClick={() => onSourceMode(!sourceOnly)}
                >
                  {sourceOnly ? 'Show all messages' : 'Task evidence'}
                </button>
              )}
            </div>
            <div className="thread-scroll" ref={thread}>
              {questions}
              {visibleMessages.map((message, index) => {
                const previous = visibleMessages[index - 1];
                const newDay =
                  !previous ||
                  new Date(previous.timestamp * 1000).toDateString() !==
                    new Date(message.timestamp * 1000).toDateString();
                const linkedTasks = annotations.get(message.id) ?? [];
                return (
                  <Fragment key={message.id}>
                    {newDay && (
                      <div className="message-day">
                        {message.timestamp ? dayLabel(message.timestamp) : 'Date unavailable'}
                      </div>
                    )}
                    <MessageCard
                      message={message}
                      name={chat.name}
                      allMessages={messages}
                      highlighted={selectedIds.has(message.id)}
                      continuation={
                        !!previous &&
                        !annotations.has(previous.id) &&
                        previous.direction === message.direction &&
                        !newDay &&
                        message.timestamp - previous.timestamp <= 300
                      }
                    />
                    {linkedTasks.map((task) => (
                      <article
                        key={task.id}
                        className={`context-task-card ${task.id === selectedTask?.id ? 'selected' : ''}`}
                      >
                        <div className="context-task-meta">
                          <span>
                            <Link2 size={13} /> Linked to {task.source_ids.length}{' '}
                            {task.source_ids.length === 1 ? 'message' : 'messages'}
                          </span>
                          <span className="task-reference">{task.reference}</span>
                        </div>
                        <button
                          className="context-task-title"
                          aria-label={`Select linked task: ${task.title}`}
                          onClick={() => onSelectTask(task)}
                        >
                          <h3>{task.title}</h3>
                          <ChevronRight size={16} />
                        </button>
                        <TaskState task={task} />
                        {task.blocking_question && !task.done && (
                          <p className="context-blocker">
                            <CircleAlert size={20} />
                            <span>{task.blocking_question}</span>
                          </p>
                        )}
                        {task.action_steps.length > 0 && (
                          <div className="context-task-steps">
                            <h4>Next steps</h4>
                            <ol>
                              {task.action_steps.slice(0, 2).map((step, i) => (
                                <li key={i}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                        <button
                          className="button primary context-open-task"
                          aria-label={`View task: ${task.title}`}
                          onClick={() => onOpenTask(task)}
                        >
                          View task <ArrowUpRight size={14} />
                        </button>
                      </article>
                    ))}
                  </Fragment>
                );
              })}
              {!visibleMessages.length && (
                <div className="thread-empty">
                  <MessageCircle size={28} />
                  <h3>
                    {sourceOnly
                      ? 'No linked messages in this conversation'
                      : 'This conversation is ready.'}
                  </h3>
                  <p>
                    {sourceOnly
                      ? 'Show all messages or choose another conversation to see the available evidence.'
                      : 'Saved messages will appear here as they arrive. Existing tasks remain in All tasks.'}
                  </p>
                  {sourceOnly && (
                    <button className="text-button" onClick={() => onSourceMode(false)}>
                      Show all messages
                    </button>
                  )}
                </div>
              )}
            </div>
            <footer className="thread-footer">
              <Link2 size={13} />
              {relatedTasks.filter((task) => !task.done).length} open{' '}
              {relatedTasks.filter((task) => !task.done).length === 1 ? 'task' : 'tasks'} · Original
              messages stay unchanged
            </footer>
          </>
        ) : (
          <div className="thread-empty">
            <MessageCircle size={30} />
            <h2>Keep the context close.</h2>
            <p>Choose a conversation to see its saved messages and the tasks they support.</p>
          </div>
        )}
      </section>
      {inspector}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Task } from './schema.js';
import type { ThreadMessage, ThreadMove, ThreadSnapshot } from './threads.js';
import { errorMessage } from './errors.js';

type Selection = { kind: 'thread'; id: string } | { kind: 'other' } | { kind: 'initial' };
type Props = {
  data: ThreadSnapshot;
  onOrganise: () => Promise<void>;
  onMove: (input: ThreadMove) => Promise<{ threadId: string | null }>;
  onOpenTask: (task: Task) => void;
  onOpenSource: (message: ThreadMessage) => void;
  onMedia: (id: string) => Promise<string>;
  sourceAction?: 'Reply in' | 'View in';
};
const dateTime = (value: number) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(value * 1000)
    : 'Time unavailable';

export function ThreadView({
  data,
  onOrganise,
  onMove,
  onOpenTask,
  onOpenSource,
  onMedia,
  sourceAction = 'Reply in',
}: Props) {
  const [selection, setSelection] = useState<Selection>(() =>
    data.threads[0] ? { kind: 'thread', id: data.threads[0].id } : { kind: 'initial' },
  );
  const [detail, setDetail] = useState(false);
  const [query, setQuery] = useState('');
  const [moving, setMoving] = useState<ThreadMessage | null>(null);
  const [target, setTarget] = useState('other');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const returnToList = useRef(false);
  const moveFocus = useRef<{ element: HTMLElement; id: string } | null>(null);
  const selected =
    selection.kind === 'thread' ? data.threads.find((t) => t.id === selection.id) : undefined;
  const messages = data.messages.filter((m) =>
    selection.kind === 'thread' ? m.threadId === selection.id : m.threadId === null,
  );
  const chatNames = new Map(data.chats.map((c) => [c.id, c.name]));
  const pausedChats = new Set(data.chats.filter((c) => !c.enabled).map((c) => c.id));
  const other = data.messages.filter((m) => m.threadId === null).length;
  useEffect(() => {
    if (selection.kind === 'initial' && data.threads[0])
      setSelection({ kind: 'thread', id: data.threads[0].id });
    if (selection.kind === 'thread' && !data.threads.some((t) => t.id === selection.id))
      setSelection(
        data.threads[0] ? { kind: 'thread', id: data.threads[0].id } : { kind: 'other' },
      );
  }, [data.threads, selection]);
  useEffect(() => {
    if (!detail && returnToList.current) {
      returnToList.current = false;
      root.current?.querySelector<HTMLButtonElement>('.t-topic[aria-pressed="true"]')?.focus();
    }
  }, [detail]);
  useEffect(() => {
    if (!moving && moveFocus.current) {
      const previous = moveFocus.current;
      moveFocus.current = null;
      const target = previous.element.isConnected
        ? previous.element
        : root.current?.querySelector<HTMLButtonElement>(
            `[data-thread-message="${CSS.escape(previous.id)}"] .t-move`,
          );
      target?.focus();
    }
  }, [moving]);
  function select(next: Selection) {
    setSelection(next);
    setDetail(true);
    setMoving(null);
    setError('');
  }
  async function organise() {
    setError('');
    try {
      await onOrganise();
    } catch (e) {
      setError(errorMessage(e, 'Could not organise threads.'));
    }
  }
  async function move(event: React.FormEvent) {
    event.preventDefault();
    if (!moving || busy) return;
    setBusy(true);
    setError('');
    const input: ThreadMove = {
      messageId: moving.id,
      expectedRevision: moving.groupingRevision,
      target:
        target === 'other'
          ? { kind: 'other' }
          : target === 'new'
            ? { kind: 'new', title }
            : { kind: 'thread', id: target },
    };
    try {
      const result = await onMove(input);
      setSelection(result.threadId ? { kind: 'thread', id: result.threadId } : { kind: 'other' });
      setMoving(null);
      setNotice('Message moved. This choice will be kept.');
    } catch (e) {
      setError(errorMessage(e, 'Could not move this message.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="t-workspace" data-detail={detail} ref={root}>
      <aside className="t-rail" aria-label="Topic threads">
        <div className="t-rail-head">
          <h1>Threads</h1>
          {data.canOrganise && (
            <button
              className="t-text"
              onClick={() => void organise()}
              disabled={data.status.kind === 'running' || data.status.kind === 'queued'}
            >
              Organise now
            </button>
          )}
        </div>
        <p className="t-scope">All connected chats</p>
        <input
          className="t-search"
          type="search"
          aria-label="Search threads"
          placeholder="Search threads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="t-topics">
          {data.threads
            .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()))
            .map((thread) => {
              const chats = new Set(
                data.messages.filter((m) => m.threadId === thread.id).map((m) => m.conversationId),
              );
              return (
                <button
                  key={thread.id}
                  className="t-topic"
                  aria-pressed={selected?.id === thread.id}
                  onClick={() => select({ kind: 'thread', id: thread.id })}
                >
                  <strong>{thread.title}</strong>
                  <small>
                    {chats.size} {chats.size === 1 ? 'chat' : 'chats'} · {thread.messageIds.length}{' '}
                    {thread.messageIds.length === 1 ? 'message' : 'messages'}
                  </small>
                </button>
              );
            })}
          {!data.threads.length && (
            <p className="t-empty">
              Related discussions will appear here. Original messages are under Other messages.
            </p>
          )}
        </div>
        <button
          className="t-topic t-other"
          aria-pressed={selection.kind === 'other'}
          onClick={() => select({ kind: 'other' })}
        >
          <strong>Other messages</strong>
          <small>
            {other} {other === 1 ? 'message' : 'messages'}
          </small>
        </button>
      </aside>
      <section className="t-discussion" aria-label="Thread messages">
        <header className="t-heading">
          <button
            className="t-back t-text"
            onClick={() => {
              returnToList.current = true;
              setDetail(false);
            }}
          >
            ← Threads
          </button>
          <div>
            <h2>{selected?.title ?? 'Other messages'}</h2>
            <p>
              {[
                ...new Set(
                  messages.map((m) => chatNames.get(m.conversationId) ?? 'Connected chat'),
                ),
              ].join(' · ') || 'Your original messages'}
            </p>
          </div>
          {selected && (
            <div className="t-task-links">
              {data.tasks
                .filter((t) => selected.taskIds.includes(t.id))
                .map((task) => (
                  <button
                    className="t-text"
                    key={task.id}
                    title={task.title}
                    onClick={() => onOpenTask(task)}
                  >
                    {task.reference}
                  </button>
                ))}
            </div>
          )}
        </header>
        {(data.status.kind === 'running' || data.status.kind === 'queued') && (
          <p className="t-progress" role="status">
            {data.status.kind === 'queued'
              ? 'Waiting for the current analysis…'
              : `Organising messages… ${data.status.remaining} left`}
          </p>
        )}
        {data.status.kind === 'error' && (
          <p className="t-error" role="alert">
            {data.status.message}{' '}
            <button className="t-text" onClick={() => void organise()}>
              Try again
            </button>
          </p>
        )}
        {error && (
          <p className="t-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <div className="t-notice" role="status">
            {notice}
            <button className="t-text" aria-label="Dismiss message" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        <div className="t-messages">
          {!messages.length && (
            <div className="t-empty">
              <h3>{data.messages.length ? 'No messages here' : 'No saved messages yet'}</h3>
              <p>
                {data.messages.length
                  ? 'Choose another thread or move a message here.'
                  : 'Connect a chat in your workspace to begin.'}
              </p>
            </div>
          )}
          {messages.map((message, index) => {
            const name = chatNames.get(message.conversationId) ?? 'Connected chat';
            const start =
              index === 0 || messages[index - 1]?.conversationId !== message.conversationId;
            return (
              <div key={message.id} className="t-message-group">
                {start && (
                  <div className="t-source">
                    <strong>
                      {name}
                      {pausedChats.has(message.conversationId) && <small> · Paused</small>}
                    </strong>
                    <button className="t-text" onClick={() => onOpenSource(message)}>
                      {sourceAction} {name}
                    </button>
                  </div>
                )}
                <article
                  className={`t-message ${message.direction}`}
                  data-thread-message={message.id}
                >
                  <div className="t-message-meta">
                    <span>
                      {message.browser_source
                        ? 'Saved selection'
                        : message.direction === 'outgoing'
                          ? 'You'
                          : 'Received'}
                    </span>
                    <button
                      className="t-time t-text"
                      aria-label={`View original message in ${name}`}
                      onClick={() => onOpenSource(message)}
                    >
                      <time>{dateTime(message.timestamp)}</time>
                    </button>
                    <button
                      className="t-move t-text"
                      aria-label="Move message to another thread"
                      title="Move to another thread"
                      onClick={(event) => {
                        moveFocus.current = { element: event.currentTarget, id: message.id };
                        setMoving(message);
                        setTarget(message.threadId ?? 'other');
                        setTitle('');
                        setError('');
                      }}
                    >
                      Move
                    </button>
                  </div>
                  {message.reply_quote && <blockquote>{message.reply_quote}</blockquote>}
                  {message.body && <p className="t-body">{message.body}</p>}
                  {message.type === 'image' && <ThreadImage id={message.id} onMedia={onMedia} />}
                  {!message.body && message.type !== 'image' && (
                    <p className="t-body">
                      {message.type === 'text' ? 'Empty message' : `${message.type} message`}
                    </p>
                  )}
                  {moving?.id === message.id && (
                    <form
                      className="t-move-form"
                      onSubmit={(e) => void move(e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setMoving(null);
                        }
                      }}
                    >
                      <label>
                        Move to another thread
                        <select
                          autoFocus
                          value={target}
                          onChange={(e) => setTarget(e.target.value)}
                        >
                          {data.threads.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.title}
                            </option>
                          ))}
                          <option value="other">Other messages</option>
                          <option value="new">New thread…</option>
                        </select>
                      </label>
                      {target === 'new' && (
                        <label>
                          Thread name
                          <input
                            required
                            maxLength={160}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                        </label>
                      )}
                      <div className="t-form-actions">
                        <button className="t-button" disabled={busy}>
                          {busy ? 'Moving…' : 'Move message'}
                        </button>
                        <button
                          className="t-text"
                          type="button"
                          disabled={busy}
                          onClick={() => setMoving(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </article>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ThreadImage({ id, onMedia }: { id: string; onMedia: (id: string) => Promise<string> }) {
  const [state, setState] = useState<
    | { kind: 'closed' }
    | { kind: 'loading' }
    | { kind: 'image'; url: string }
    | { kind: 'error'; message: string }
  >({ kind: 'closed' });
  async function open() {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'image', url: await onMedia(id) });
    } catch (e) {
      setState({
        kind: 'error',
        message: errorMessage(e, 'The original image is unavailable.'),
      });
    }
  }
  return (
    <div
      className={
        state.kind === 'image' || state.kind === 'loading' ? 't-image-frame' : 't-attachment'
      }
    >
      {state.kind === 'image' ? (
        <img className="t-image" src={state.url} alt="Original image from this message" />
      ) : (
        <button className="t-text" disabled={state.kind === 'loading'} onClick={() => void open()}>
          {state.kind === 'loading' ? 'Loading image…' : 'View original image'}
        </button>
      )}
      {state.kind === 'error' && <p role="alert">{state.message}</p>}
    </div>
  );
}

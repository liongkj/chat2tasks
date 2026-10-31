import type { Notify } from '../shared/useNotice.js';
import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Clock3, Plus } from 'lucide-react';
import {
  WaitEvidenceSchema,
  WaitSchema,
  type Chat,
  type Message,
  type Task,
  type Wait,
} from '../shared/schema.js';
import { api, time } from './api.js';
import { MessageCard } from './Evidence.js';

export function WaitingView({
  waits,
  tasks,
  messages,
  chats,
  selectedId,
  onSelect,
  onOpenTask,
  onRefresh,
  notify,
  navigationTrigger,
}: {
  waits: Wait[];
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpenTask: (task: Task) => void;
  onRefresh: () => Promise<void>;
  notify: Notify;
  navigationTrigger: ReactNode;
}) {
  const [history, setHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const [expected, setExpected] = useState('');
  const [person, setPerson] = useState('');
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = waits.filter((wait) =>
    history
      ? wait.state !== 'waiting'
      : wait.state === 'waiting' && (!wait.needs_review || wait.id === selectedId),
  );
  const selected = waits.find((wait) => wait.id === selectedId) ?? visible[0];
  const linked = tasks.find((task) => task.id === selected?.task_id);
  const evidence = messages.filter(
    (message) => selected?.source_ids.includes(message.id) || message.id === selected?.response_id,
  );
  const response = evidence.find((message) => message.id === selected?.response_id);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const wait = await api('waiting', WaitSchema, {
        expected,
        person: person.trim() || null,
        task_id: taskId || null,
        source_ids: [],
      });
      setExpected('');
      setPerson('');
      setTaskId('');
      setCreating(false);
      setHistory(false);
      await onRefresh();
      onSelect(wait.id);
      notify('Added to Waiting for');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save this waiting item.', 'error');
    } finally {
      setBusy(false);
    }
  }
  async function change(state: 'waiting' | 'received' | 'dismissed') {
    if (!selected) return;
    setBusy(true);
    try {
      await api('waiting/state', WaitEvidenceSchema, { id: selected.id, state });
      setHistory(state !== 'waiting');
      await onRefresh();
      notify(
        state === 'received'
          ? 'Marked as received'
          : state === 'dismissed'
            ? 'Stopped tracking'
            : 'Waiting item reopened',
      );
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'Could not update this waiting item.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!selected) return;
    setBusy(true);
    try {
      await api('waiting/confirm', WaitEvidenceSchema, { id: selected.id });
      await onRefresh();
      notify(response ? 'Still waiting' : 'Added to Waiting for');
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'Could not confirm this waiting item.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`task-layout waiting-layout ${selectedId ? 'waiting-has-selection' : ''}`}>
      <section className="task-column" aria-label="Waiting for list">
        <div className="page-heading">
          {navigationTrigger}
          <h1>Waiting for</h1>
          <span className="open-task-count">{visible.length}</span>
          <button
            className="icon-btn"
            aria-label="Add waiting item"
            onClick={() => setCreating(!creating)}
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="waiting-switch" role="group" aria-label="Waiting status">
          <button
            aria-pressed={!history}
            onClick={() => {
              setHistory(false);
              onSelect(null);
            }}
          >
            Waiting
          </button>
          <button
            aria-pressed={history}
            onClick={() => {
              setHistory(true);
              onSelect(null);
            }}
          >
            History
          </button>
        </div>
        {creating && (
          <form className="waiting-create" onSubmit={(event) => void create(event)}>
            <label>
              What are you waiting for?
              <input
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
                required
                maxLength={4000}
              />
            </label>
            <label>
              From whom? <span className="field-hint">optional</span>
              <input
                value={person}
                onChange={(event) => setPerson(event.target.value)}
                maxLength={500}
              />
            </label>
            <label>
              Linked item <span className="field-hint">optional</span>
              <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
                <option value="">None</option>
                {tasks
                  .filter((task) => !task.done)
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.reference} · {task.title}
                    </option>
                  ))}
              </select>
            </label>
            <button className="button primary" disabled={busy}>
              Add to Waiting for
            </button>
          </form>
        )}
        <div className="task-list">
          {visible.map((wait) => (
            <button
              key={wait.id}
              className={`waiting-row ${selected?.id === wait.id ? 'selected' : ''}`}
              aria-pressed={selected?.id === wait.id}
              onClick={() => onSelect(wait.id)}
            >
              <span className="waiting-row-title">{wait.expected}</span>
              <span>
                {wait.person ? `From ${wait.person}` : 'Person not specified'}
                {wait.needs_review ? ' · Needs review' : ''}
              </span>
            </button>
          ))}
          {!visible.length && !creating && (
            <div className="empty-state">
              <Clock3 size={26} />
              <h2>{history ? 'No waiting history yet' : 'Nothing waiting right now'}</h2>
              <p>Requests you’re waiting on will appear here.</p>
            </div>
          )}
        </div>
      </section>
      <aside className="inspector desk-inspector waiting-detail" aria-label="Waiting item details">
        {selected ? (
          <div className="task-document detail-body">
            <header className="task-document-heading">
              <button className="text-button waiting-back" onClick={() => onSelect(null)}>
                <ArrowLeft size={16} /> Back to waiting
              </button>
              <div className="task-reference-bar">
                <span className="item-kind">Waiting for</span>
                <span className="task-state">
                  {selected.state === 'waiting'
                    ? 'Waiting'
                    : selected.state === 'received'
                      ? 'Received'
                      : 'Dismissed'}
                </span>
              </div>
              <h2>{selected.expected}</h2>
              <p>{selected.person ? `From ${selected.person}` : 'Person not specified'}</p>
            </header>
            <div className="detail-scroll">
              {selected.needs_review && (
                <div className="blocker">
                  <div>
                    <span>Needs your review</span>
                    <p>
                      {response
                        ? 'Does this reply provide what you were waiting for?'
                        : 'Is this something you are waiting for?'}
                    </p>
                  </div>
                </div>
              )}
              {linked && (
                <section className="detail-section">
                  <h3>Linked item</h3>
                  <button className="text-button" onClick={() => onOpenTask(linked)}>
                    {linked.reference} · {linked.title}
                  </button>
                </section>
              )}
              {evidence.length > 0 && (
                <section className="detail-section">
                  <h3>Conversation evidence</h3>
                  {evidence.map((message) => (
                    <MessageCard
                      key={message.id}
                      message={message}
                      name={
                        chats.find(
                          (chat) =>
                            chat.sessionId === message.sessionId && chat.chatId === message.chatId,
                        )?.name ?? 'Saved conversation'
                      }
                      allMessages={messages}
                      compact
                    />
                  ))}
                </section>
              )}
              <p className="field-hint">
                Tracking this response does not complete its linked task. Updated{' '}
                {time(selected.updated)}.
              </p>
            </div>
            <div className="detail-actions">
              {selected.state === 'waiting' ? (
                <>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void change('dismissed')}
                  >
                    Stop tracking
                  </button>
                  {selected.needs_review && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void confirm()}
                    >
                      {response ? 'Still waiting' : 'Track this'}
                    </button>
                  )}
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void change('received')}
                  >
                    <Check size={16} /> Mark received
                  </button>
                </>
              ) : (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void change('waiting')}
                >
                  Reopen waiting item
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="inspector-empty">
            <Clock3 size={27} />
            <h2>Choose a waiting item</h2>
            <p>See the request, its source, and any linked work here.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

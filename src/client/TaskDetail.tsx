import type { Notify } from '../shared/useNotice.js';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Circle,
  CircleAlert,
  Clipboard,
  Copy,
  Link2,
  LoaderCircle,
  NotebookPen,
} from 'lucide-react';
import { z } from 'zod';
import {
  ItemKindSchema,
  type Chat,
  type ItemKind,
  type Message,
  type Task,
  type TaskEvidence,
} from '../shared/schema.js';
import { itemKindLabel, itemKindPlural } from '../shared/tasks.js';
import { api, download, OkSchema, time } from './api.js';
import { stateLabel, conversationName } from './conversations.js';
import { MessageCard } from './Evidence.js';
import { taskUrl, type TaskTab } from './taskLocation.js';
import { TaskMerge } from './TaskMerge.js';
import { GtdEditor } from './GtdEditor.js';

export function TaskState({ task }: { task: Task }) {
  return (
    <span className={`task-state ${task.done ? 'completed' : task.triage_state}`}>
      {task.done ? (
        <Check size={12} />
      ) : task.triage_state === 'needs_info' ? (
        <CircleAlert size={12} />
      ) : (
        <Circle size={10} />
      )}
      {task.done
        ? task.resolution?.kind === 'filtered'
          ? 'Not an item'
          : task.kind === 'question'
            ? 'Answered'
            : task.kind === 'reminder'
              ? 'Dismissed'
              : 'Completed'
        : task.gtd.commitment === 'someday'
          ? 'Someday'
          : stateLabel[task.triage_state]}
    </span>
  );
}

export function TaskDetail({
  layout = 'context',
  task,
  tasks,
  messages,
  chats,
  tab,
  onTabChange,
  onTick,
  completionConfirmed,
  ticking,
  onSaved,
  onKindChanged,
  onMerged,
  notify,
}: {
  layout?: 'desk' | 'context';
  task: Task;
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  tab: TaskTab;
  onTabChange: (tab: TaskTab) => void;
  onTick: () => void;
  completionConfirmed: boolean;
  ticking: boolean;
  onSaved: () => void;
  onKindChanged: (kind: ItemKind) => void;
  onMerged: (evidence: TaskEvidence) => void;
  notify: Notify;
}) {
  const [remark, setRemark] = useState(task.own_remark);
  const [saving, setSaving] = useState(false);
  const [kindSaving, setKindSaving] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const note = useRef<HTMLTextAreaElement>(null);
  const noteId = useId();
  const focusNote = useRef(false);
  const sources = messages.filter((message) => task.source_ids.includes(message.id));
  useEffect(() => {
    if (notesOpen && focusNote.current) {
      focusNote.current = false;
      note.current?.focus();
    }
  }, [notesOpen]);
  const addInformation = () => {
    focusNote.current = true;
    setNotesOpen(true);
    if (notesOpen) note.current?.focus();
  };
  async function save() {
    setSaving(true);
    try {
      await api('remark', OkSchema, { id: task.id, remark });
      onSaved();
      notify('Your note is saved');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save your note.', 'error');
    } finally {
      setSaving(false);
    }
  }
  async function changeKind(value: string) {
    const kind = ItemKindSchema.parse(value);
    setKindSaving(true);
    try {
      await api('tasks/kind', OkSchema, { id: task.id, kind });
      onKindChanged(kind);
      notify(`Moved to ${itemKindPlural[kind].toLowerCase()}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not change the category.', 'error');
    } finally {
      setKindSaving(false);
    }
  }
  async function prepare() {
    setHandoff(true);
    try {
      if (remark !== task.own_remark) {
        await api('remark', OkSchema, { id: task.id, remark });
        onSaved();
      }
      const file = await api('handoff', z.object({ filename: z.string(), content: z.string() }), {
        id: task.id,
      });
      download(file.filename, file.content, 'text/markdown');
      notify('Handoff prepared and downloaded');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not prepare the handoff.', 'error');
    } finally {
      setHandoff(false);
    }
  }
  const heading = (
    <>
      <div className="task-reference-bar">
        <span className="task-reference">{task.reference}</span>
        <label className="item-kind-selector">
          <span className="sr-only">Item category</span>
          <select
            aria-label="Item category"
            value={task.kind}
            disabled={kindSaving}
            onChange={(event) => void changeKind(event.target.value)}
          >
            {ItemKindSchema.options.map((kind) => (
              <option key={kind} value={kind}>
                {itemKindLabel[kind]}
              </option>
            ))}
          </select>
        </label>
        {layout === 'desk' && (
          <span className="task-conversation" title={conversationName(task, messages, chats)}>
            {conversationName(task, messages, chats)}
          </span>
        )}
        <TaskState task={task} />
      </div>
      <h2 className={task.done ? 'task-done-title' : ''}>{task.title}</h2>
      {task.kind_suggestion && (
        <p className="item-kind-suggestion">
          {task.kind_suggestion === task.kind
            ? 'Please check the category.'
            : `Possible category: ${itemKindLabel[task.kind_suggestion]}.`}{' '}
          Choose a category or{' '}
          <button
            className="text-button"
            disabled={kindSaving}
            onClick={() => void changeKind(task.kind)}
          >
            keep {itemKindLabel[task.kind].toLowerCase()}
          </button>
          .
        </p>
      )}
    </>
  );
  const sourceMessages = (
    <>
      <p className="source-intro">
        The saved messages behind this task. Dates use your local timezone.
      </p>
      {sources.map((message) => (
        <MessageCard
          key={message.id}
          message={message}
          name={
            chats.find(
              (chat) => chat.chatId === message.chatId && chat.sessionId === message.sessionId,
            )?.name ?? 'Saved conversation'
          }
          allMessages={messages}
          compact={layout === 'desk'}
        />
      ))}
      {!sources.length && (
        <p className="empty-copy">No source messages are available for this task.</p>
      )}
    </>
  );
  const copyLink = (
    <button
      className="text-button"
      aria-label="Copy task link"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(taskUrl(task.reference, tab));
          notify('Task link copied');
        } catch {
          notify('Could not copy the task link. Copy the address from your browser.', 'error');
        }
      }}
    >
      <Copy size={14} />
      Copy link
      <ArrowUpRight size={12} />
    </button>
  );
  return (
    <div className={`detail-body ${layout === 'desk' ? 'task-document' : ''}`}>
      {layout === 'desk' && <header className="task-document-heading">{heading}</header>}
      <div className="detail-scroll">
        {layout === 'context' && heading}
        {tab === 'sources' && layout === 'context' ? (
          <div className="source-list">
            <button className="text-button" onClick={() => onTabChange('overview')}>
              Back to task
            </button>
            {sourceMessages}
          </div>
        ) : (
          <>
            {task.note && (
              <>
                <p
                  className={`task-note ${task.note.length > 220 && !backgroundOpen ? 'collapsed' : ''}`}
                >
                  {task.note}
                </p>
                {task.note.length > 220 && (
                  <button
                    className="text-button background-toggle"
                    aria-expanded={backgroundOpen}
                    onClick={() => setBackgroundOpen(!backgroundOpen)}
                  >
                    {backgroundOpen ? 'Less background' : 'Read full background'}
                  </button>
                )}
              </>
            )}
            {task.blocking_question && !task.done && (
              <div className="blocker">
                <CircleAlert size={20} />
                <div>
                  <span>Missing information</span>
                  <p>{task.blocking_question}</p>
                </div>
              </div>
            )}
            {task.action_steps.length > 0 && (
              <section className="detail-section">
                <h3>Next steps</h3>
                <ol className="steps">
                  {task.action_steps.map((step, index) => (
                    <li key={index}>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {task.done_when.length > 0 && (
              <section className="detail-section completion-criteria">
                <h3>{layout === 'desk' ? 'Complete when' : 'Completion criteria'}</h3>
                <ul className="criteria">
                  {task.done_when.map((criterion, index) => (
                    <li key={index}>
                      <Circle size={17} />
                      <span>{criterion}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(task.gtd.project ||
              task.gtd.area ||
              task.gtd.times.length > 0 ||
              task.gtd.recurrence) && (
              <div className="gtd-summary">
                {task.gtd.project && <span>Project: {task.gtd.project}</span>}
                {task.gtd.area && <span>Area: {task.gtd.area}</span>}
                {task.gtd.times.map((entry, index) => (
                  <span key={index}>
                    {entry.kind === 'due'
                      ? 'Due'
                      : entry.kind === 'scheduled'
                        ? 'Scheduled'
                        : 'Revisit'}
                    : {entry.text}
                    {entry.date && entry.date !== entry.text ? ` (${entry.date})` : ''}
                  </span>
                ))}
                {task.gtd.recurrence && (
                  <span>
                    Repeats {task.gtd.recurrence.frequency} · next {task.gtd.recurrence.next_date}
                  </span>
                )}
              </div>
            )}
            <GtdEditor
              key={`${task.id}:${JSON.stringify(task.gtd)}`}
              task={task}
              onSaved={onSaved}
              notify={notify}
            />
            {layout === 'desk' ? (
              <details
                className="detail-section source-disclosure"
                open={tab === 'sources'}
                onToggle={(event) => {
                  if (event.currentTarget.open !== (tab === 'sources'))
                    onTabChange(event.currentTarget.open ? 'sources' : 'overview');
                }}
              >
                <summary>
                  <Link2 size={16} />
                  <span>
                    {task.source_ids.length} original{' '}
                    {task.source_ids.length === 1 ? 'message' : 'messages'}
                  </span>
                  <ArrowUpRight size={14} />
                </summary>
                <div className="source-list">{sourceMessages}</div>
              </details>
            ) : (
              <section className="detail-section source-preview">
                <h3>From the conversation</h3>
                {sources[0] && (
                  <blockquote>
                    <p>{sources[0].body || 'Image attachment'}</p>
                    <cite>
                      {conversationName(task, messages, chats)} · {time(sources[0].timestamp)}
                    </cite>
                  </blockquote>
                )}
                <button className="text-button" onClick={() => onTabChange('sources')}>
                  <Link2 size={15} /> View conversation
                  {sources.length > 1 ? ` (${sources.length})` : ''}
                </button>
              </section>
            )}
            <details
              className="detail-section note-section"
              open={notesOpen}
              onToggle={(event) => setNotesOpen(event.currentTarget.open)}
            >
              <summary>{layout === 'desk' && <NotebookPen size={16} />}Notes &amp; handoff</summary>
              <label className="note-label" htmlFor={noteId}>
                Your note
              </label>
              {task.blocking_question && (
                <p className="note-hint">
                  Record the missing details here as a personal note. Saving a note does not change
                  readiness.
                </p>
              )}
              <textarea
                ref={note}
                id={noteId}
                aria-label="Your note"
                placeholder="Add details, a link, or something to remember…"
                maxLength={4000}
                value={remark}
                onChange={(event) => setRemark(event.target.value)}
                rows={3}
              />
              <button
                className="text-button"
                disabled={saving || remark === task.own_remark}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save note'} <Check size={14} />
              </button>
              <div className="secondary-actions">
                {layout === 'desk' && copyLink}
                <button
                  className="button secondary"
                  disabled={handoff}
                  onClick={() => void prepare()}
                >
                  {handoff ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )}
                  {handoff ? 'Preparing…' : 'Download handoff'}
                </button>
                <button
                  className="icon-btn"
                  aria-label="Copy raw task context"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        JSON.stringify({ task, source_messages: sources }, null, 2),
                      );
                      notify('Task context copied');
                    } catch {
                      notify(
                        'Clipboard unavailable. Export the workspace from the task menu.',
                        'error',
                      );
                    }
                  }}
                >
                  <Clipboard size={16} />
                </button>
              </div>
              <TaskMerge
                task={task}
                tasks={tasks}
                dirty={saving || ticking || remark !== task.own_remark}
                onMerged={onMerged}
                notify={notify}
              />
              {task.merged_from.length > 0 && (
                <section className="merge-history">
                  <h3>Merged tasks</h3>
                  {task.merged_from.map((source) => (
                    <div key={source.id}>
                      <p>
                        <strong>{source.reference}</strong> · {source.title}
                      </p>
                      {source.own_remark && <blockquote>{source.own_remark}</blockquote>}
                      {source.gtd.project && <p>Project: {source.gtd.project}</p>}
                    </div>
                  ))}
                </section>
              )}
              <p className="detail-scope">
                {task.scope}
                {task.priority === 'high' ? ' · High priority' : ''}
              </p>
              <p className="updated-note">Updated {time(task.updated)}</p>
            </details>
          </>
        )}
      </div>
      <div className="detail-actions">
        {layout === 'desk' && (
          <span className="completion-caption">
            {ticking
              ? 'Saving…'
              : task.done
                ? task.resolution?.kind === 'filtered'
                  ? 'Filtered as not a task. You can reopen it.'
                  : task.resolution?.kind === 'reply'
                    ? 'Resolved from your reply. You can reopen it.'
                    : 'You marked this complete.'
                : task.gtd.recurrence
                  ? 'Completing this occurrence keeps future occurrences open.'
                  : task.kind === 'question'
                    ? 'A clear answer can resolve this question.'
                    : task.kind === 'reminder'
                      ? 'Dismiss this reminder when you no longer need it.'
                      : 'Completion is your call.'}
          </span>
        )}
        {layout === 'context' &&
          !task.done &&
          task.triage_state === 'needs_info' &&
          tab === 'overview' && (
            <button className="button primary" onClick={addInformation}>
              <NotebookPen size={16} /> Add missing information
            </button>
          )}
        <button
          className={`button ${!task.done && (layout === 'desk' || task.triage_state !== 'needs_info') ? 'primary' : 'secondary'}`}
          disabled={ticking}
          onClick={onTick}
        >
          {ticking && <LoaderCircle size={15} className="spin" />}
          {layout === 'desk' && !ticking && (
            <Check className={completionConfirmed ? 'completion-confirmed' : undefined} size={16} />
          )}
          {ticking
            ? 'Saving…'
            : task.done
              ? task.kind === 'reminder'
                ? 'Restore reminder'
                : task.kind === 'question'
                  ? 'Reopen question'
                  : task.kind === 'event' || task.kind === 'reference'
                    ? 'Restore item'
                    : 'Reopen task'
              : task.kind === 'reminder'
                ? 'Dismiss reminder'
                : task.kind === 'question'
                  ? 'Mark answered'
                  : task.kind === 'event' || task.kind === 'reference'
                    ? 'Archive item'
                    : task.gtd.recurrence
                      ? 'Complete occurrence'
                      : 'Mark complete'}
        </button>
        {layout === 'context' && (
          <div className="detail-secondary">
            <button className="text-button" onClick={addInformation}>
              <NotebookPen size={15} /> {task.own_remark ? 'Edit note' : 'Add note'}
            </button>
            {copyLink}
          </div>
        )}
      </div>
    </div>
  );
}

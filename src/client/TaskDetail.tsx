import { useEffect, useRef, useState } from 'react';
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
import type { Chat, Message, Task, TaskEvidence } from '../shared/schema.js';
import { api, download, OkSchema, time } from './api.js';
import { stateLabel, conversationName } from './conversations.js';
import { MessageCard } from './Evidence.js';
import { taskUrl, type TaskTab } from './taskLocation.js';
import { TaskMerge } from './TaskMerge.js';

export function TaskState({ task }: { task: Task }) {
  return (
    <span className={`task-state ${task.done ? 'completed' : task.triage_state}`}>
      {task.done ? <Check size={12} /> : <span aria-hidden="true" className="state-dot" />}
      {task.done ? 'Completed' : stateLabel[task.triage_state]}
    </span>
  );
}

export function TaskDetail({
  task,
  tasks,
  messages,
  chats,
  tab,
  onTabChange,
  onTick,
  ticking,
  onSaved,
  onMerged,
  notify,
}: {
  task: Task;
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  tab: TaskTab;
  onTabChange: (tab: TaskTab) => void;
  onTick: () => void;
  ticking: boolean;
  onSaved: () => void;
  onMerged: (evidence: TaskEvidence) => void;
  notify: (text: string) => void;
}) {
  const [remark, setRemark] = useState(task.own_remark);
  const [saving, setSaving] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const note = useRef<HTMLTextAreaElement>(null);
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
      notify(error instanceof Error ? error.message : 'Could not save your note.');
    } finally {
      setSaving(false);
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
      notify(error instanceof Error ? error.message : 'Could not prepare the handoff.');
    } finally {
      setHandoff(false);
    }
  }
  return (
    <div className="detail-body">
      <div className="detail-scroll">
        <div className="task-reference-bar">
          <span className="task-reference">{task.reference}</span>
          <TaskState task={task} />
        </div>
        <h2 className={task.done ? 'task-done-title' : ''}>{task.title}</h2>
        {tab === 'sources' ? (
          <div className="source-list">
            <button className="text-button" onClick={() => onTabChange('overview')}>
              Back to task
            </button>
            <p className="source-intro">
              The saved messages behind this task. Dates use your local timezone.
            </p>
            {sources.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                name={
                  chats.find(
                    (chat) =>
                      chat.chatId === message.chatId && chat.sessionId === message.sessionId,
                  )?.name ?? 'Saved conversation'
                }
                allMessages={messages}
              />
            ))}
            {!sources.length && (
              <p className="empty-copy">No source messages are available for this task.</p>
            )}
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
                <h3>Completion criteria</h3>
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
            <details
              className="detail-section note-section"
              open={notesOpen}
              onToggle={(event) => setNotesOpen(event.currentTarget.open)}
            >
              <summary>Notes &amp; handoff</summary>
              <label className="note-label" htmlFor="task-note">
                Your note
              </label>
              {task.blocking_question && (
                <p className="note-hint">Record the missing details here as a personal note.</p>
              )}
              <textarea
                ref={note}
                id="task-note"
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
                      notify('Clipboard unavailable. Export the workspace from the task menu.');
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
        {!task.done && task.triage_state === 'needs_info' && tab === 'overview' && (
          <button className="button primary" onClick={addInformation}>
            <NotebookPen size={16} /> Add missing information
          </button>
        )}
        <button
          className={`button ${!task.done && task.triage_state !== 'needs_info' ? 'primary' : 'secondary'}`}
          disabled={ticking}
          onClick={onTick}
        >
          {ticking && <LoaderCircle size={15} className="spin" />}
          {task.done ? 'Reopen task' : 'Mark Complete'}
        </button>
        <div className="detail-secondary">
          <button className="text-button" onClick={addInformation}>
            <NotebookPen size={15} /> {task.own_remark ? 'Edit note' : 'Add note'}
          </button>
          <button
            className="text-button"
            aria-label="Copy task link"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(taskUrl(task.reference, tab));
                notify('Task link copied');
              } catch {
                notify('Could not copy the task link. Copy the address from your browser.');
              }
            }}
          >
            <Copy size={14} /> Copy link <ArrowUpRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

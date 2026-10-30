import type { ReactNode } from 'react';
import { ArrowRight, Circle, Clock3, LoaderCircle } from 'lucide-react';
import type { ItemKind, Snapshot, Task, Wait } from '../shared/schema.js';
import { isUpcoming } from '../shared/tasks.js';

export function Overview({
  tasks,
  waits,
  pendingQuestions,
  loaded,
  online,
  messageCount,
  followedConversations,
  status,
  requestingSync,
  onOpenTask,
  onOpenWait,
  onCategory,
  onWaiting,
  onUpcoming,
  onReview,
  onActivity,
  onConnections,
  onImportWorkspace,
  navigationTrigger,
}: {
  tasks: Task[];
  waits: Wait[];
  pendingQuestions: number;
  loaded: boolean;
  online: boolean;
  messageCount: number;
  followedConversations: number | null;
  status: Snapshot['status'];
  requestingSync: boolean;
  onOpenTask: (task: Task) => void;
  onOpenWait: (wait: Wait) => void;
  onCategory: (kind: ItemKind) => void;
  onWaiting: () => void;
  onUpcoming: () => void;
  onReview: () => void;
  onActivity: () => void;
  onConnections: () => void;
  onImportWorkspace?: () => void;
  navigationTrigger: ReactNode;
}) {
  const open = tasks.filter((task) => !task.done && task.gtd.commitment === 'active');
  const activeWaits = waits.filter((wait) => wait.state === 'waiting' && !wait.needs_review);
  const upcoming = open.filter((task) => isUpcoming(task));
  const emptyWorkspace = !tasks.length && !waits.length && !pendingQuestions && !messageCount;
  const working = status.syncing || status.debouncing || requestingSync;
  const reviewCount =
    tasks.filter((task) => !task.done && task.kind_suggestion).length +
    waits.filter((wait) => wait.state === 'waiting' && wait.needs_review).length +
    pendingQuestions;
  const sections = [
    { kind: 'action', label: 'Actions', hint: 'Next things you can do' },
    { kind: 'question', label: 'Questions', hint: 'Answers and decisions needed from you' },
    { kind: 'task', label: 'Tasks', hint: 'Work that needs an outcome' },
    { kind: 'reminder', label: 'Reminders', hint: 'Things to keep in mind' },
  ] satisfies { kind: ItemKind; label: string; hint: string }[];
  return (
    <div className="overview-page">
      <header className="overview-heading">
        {navigationTrigger}
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1>Overview</h1>
          <p>See what needs your attention across your conversations.</p>
        </div>
      </header>
      {!loaded ? (
        <div className="overview-status" role="status">
          <LoaderCircle className="spin" size={20} />
          <div>
            <strong>Opening your workspace…</strong>
            <p>Your tasks and conversations will appear here.</p>
          </div>
        </div>
      ) : online && working ? (
        <div className="overview-status" role="status">
          <LoaderCircle className="spin" size={20} />
          <div>
            <strong>
              {requestingSync
                ? 'Starting analysis…'
                : status.syncing
                  ? status.phase
                  : 'Waiting for a quiet moment'}
            </strong>
            <p>
              {status.debouncing && !status.syncing
                ? 'New messages will be checked shortly.'
                : 'This can take a moment. You can keep using Chat2Tasks.'}
            </p>
          </div>
          <button className="text-button" onClick={onActivity}>
            View activity
          </button>
        </div>
      ) : null}
      {loaded && online && !status.error && !working && emptyWorkspace && (
        <section className="overview-welcome">
          <h2>
            {followedConversations === null
              ? 'Checking your conversations…'
              : followedConversations
                ? 'Waiting for messages'
                : 'Choose conversations to follow'}
          </h2>
          <p>
            {followedConversations === null
              ? 'Your workspace is open. We’re checking your conversation settings.'
              : followedConversations
                ? `You’re following ${followedConversations} ${followedConversations === 1 ? 'conversation' : 'conversations'}. Items appear here after Chat2Tasks receives and checks their messages.`
                : 'Choose which WhatsApp conversations Chat2Tasks should follow.'}
          </p>
          {followedConversations === 0 && (
            <button className="button secondary" onClick={onConnections}>
              Choose conversations
            </button>
          )}
          {onImportWorkspace && (
            <div className="overview-import">
              <span>Already have tasks in another workspace?</span>
              <button className="text-button" onClick={onImportWorkspace}>
                Import your workspace <ArrowRight size={14} />
              </button>
            </div>
          )}
        </section>
      )}
      {loaded && !emptyWorkspace && (
        <>
          {reviewCount > 0 && (
            <button className="review-banner" onClick={onReview}>
              <span>
                <strong>
                  {reviewCount} {reviewCount === 1 ? 'item needs' : 'items need'} review
                </strong>
                <small>Check uncertain categories or possible replies.</small>
              </span>
              <ArrowRight size={18} />
            </button>
          )}
          <div className="overview-grid">
            {sections.map((section) => {
              const items = open.filter(
                (task) => task.kind === section.kind && !task.kind_suggestion,
              );
              return (
                <section className="overview-section" key={section.kind}>
                  <div className="overview-section-heading">
                    <div>
                      <h2>{section.label}</h2>
                      <p>{section.hint}</p>
                    </div>
                    <button className="text-button" onClick={() => onCategory(section.kind)}>
                      View all <ArrowRight size={14} />
                    </button>
                  </div>
                  {items.slice(0, 3).map((task) => (
                    <button className="overview-row" key={task.id} onClick={() => onOpenTask(task)}>
                      <Circle size={16} />
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {task.reference} · {task.scope}
                          {task.gtd.project ? ` · ${task.gtd.project}` : ''}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!items.length && <p className="overview-empty">Nothing here right now.</p>}
                </section>
              );
            })}
            <section className="overview-section">
              <div className="overview-section-heading">
                <div>
                  <h2>Waiting for</h2>
                  <p>Responses or results from others</p>
                </div>
                <button className="text-button" onClick={onWaiting}>
                  View all <ArrowRight size={14} />
                </button>
              </div>
              {activeWaits.slice(0, 3).map((wait) => (
                <button className="overview-row" key={wait.id} onClick={() => onOpenWait(wait)}>
                  <Clock3 size={16} />
                  <span>
                    <strong>{wait.expected}</strong>
                    <small>{wait.person ? `From ${wait.person}` : 'Person not specified'}</small>
                  </span>
                </button>
              ))}
              {!activeWaits.length && <p className="overview-empty">Nothing waiting right now.</p>}
            </section>
            <section className="overview-section">
              <div className="overview-section-heading">
                <div>
                  <h2>Upcoming</h2>
                  <p>Dates you want to keep in view</p>
                </div>
                <button className="text-button" onClick={onUpcoming}>
                  View all <ArrowRight size={14} />
                </button>
              </div>
              {upcoming.slice(0, 3).map((task) => (
                <button className="overview-row" key={task.id} onClick={() => onOpenTask(task)}>
                  <Clock3 size={16} />
                  <span>
                    <strong>{task.title}</strong>
                    <small>{task.gtd.times[0]?.text ?? task.gtd.recurrence?.next_date}</small>
                  </span>
                </button>
              ))}
              {!upcoming.length && <p className="overview-empty">No dates to show.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

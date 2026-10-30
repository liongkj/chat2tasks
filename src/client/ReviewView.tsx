import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { itemKindLabel } from '../shared/tasks.js';
import type { Task, Wait } from '../shared/schema.js';

export function ReviewView({
  tasks,
  waits,
  onOpenTask,
  onOpenWait,
  questions,
  pendingQuestions,
  navigationTrigger,
}: {
  tasks: Task[];
  waits: Wait[];
  onOpenTask: (task: Task) => void;
  onOpenWait: (wait: Wait) => void;
  questions: ReactNode;
  pendingQuestions: number;
  navigationTrigger: ReactNode;
}) {
  const uncertainTasks = tasks.filter((task) => !task.done && task.kind_suggestion);
  const uncertainWaits = waits.filter((wait) => wait.state === 'waiting' && wait.needs_review);
  return (
    <div className="review-page">
      <div className="page-heading">
        {navigationTrigger}
        <h1>Review</h1>
      </div>
      <p className="review-intro">
        Check uncertain categories and possible replies before they change your work.
      </p>
      {questions}
      {uncertainTasks.map((task) => (
        <button className="review-row" key={task.id} onClick={() => onOpenTask(task)}>
          <CircleAlert size={18} />
          <span>
            <strong>{task.title}</strong>
            <small>
              {task.reference} ·{' '}
              {task.kind_suggestion === task.kind
                ? 'Check category'
                : `Possible ${itemKindLabel[task.kind_suggestion ?? task.kind].toLowerCase()}`}
            </small>
          </span>
        </button>
      ))}
      {uncertainWaits.map((wait) => (
        <button className="review-row" key={wait.id} onClick={() => onOpenWait(wait)}>
          <CircleAlert size={18} />
          <span>
            <strong>{wait.expected}</strong>
            <small>
              {wait.response_id
                ? 'Possible response to your request'
                : 'Check whether you are waiting for this'}
            </small>
          </span>
        </button>
      ))}
      {!uncertainTasks.length && !uncertainWaits.length && !pendingQuestions && (
        <p className="empty-copy">Nothing needs review right now.</p>
      )}
    </div>
  );
}

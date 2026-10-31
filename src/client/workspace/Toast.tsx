import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import type { Task } from '../../shared/schema.js';
import type { NoticeVariant } from '../../shared/useNotice.js';
import type { CompletionNotice } from './useTaskTick.js';

export type Notice =
  { kind: 'message'; text: string; variant: NoticeVariant; undo?: () => void } | CompletionNotice;

export function Toast({
  notice,
  exiting,
  undoTask,
  undoBusy,
  onUndo,
  onUndoMessage,
  onDismiss,
}: {
  notice: Notice;
  exiting: boolean;
  /** The task a completion notice can undo, when it is still in the snapshot. */
  undoTask: Task | undefined;
  undoBusy: boolean;
  onUndo: (task: Task, previousDone: boolean) => void;
  /** Runs a message notice's own undo, then closes the toast. */
  onUndoMessage: () => void;
  onDismiss: () => void;
}) {
  const error = notice.kind === 'message' && notice.variant === 'error';
  const undo = notice.kind === 'completion' ? notice : null;
  return (
    <div
      className={`toast ${notice.kind === 'message' ? notice.variant : 'success'}`}
      data-exiting={exiting}
      role={exiting ? undefined : error ? 'alert' : 'status'}
    >
      {error ? (
        <TriangleAlert size={17} />
      ) : notice.kind === 'message' && notice.variant === 'info' ? (
        <Info size={17} />
      ) : (
        <CheckCircle2
          className={notice.kind === 'completion' && notice.done ? 'completion-confirmed' : ''}
          size={17}
        />
      )}
      <span>{notice.text}</span>
      {notice.kind === 'message' && notice.undo && (
        <button className="toast-undo" onClick={onUndoMessage}>
          Undo
        </button>
      )}
      {undo && (
        <button
          className="toast-undo"
          disabled={!undoTask || undoTask.done !== undo.done || undoBusy}
          onClick={() => {
            if (undoTask) onUndo(undoTask, undo.previousDone);
          }}
        >
          Undo
        </button>
      )}
      <button className="icon-btn" aria-label="Dismiss notification" onClick={onDismiss}>
        <X size={15} />
      </button>
    </div>
  );
}

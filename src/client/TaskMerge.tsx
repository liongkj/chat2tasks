import { useState } from 'react';
import { Link2, LoaderCircle } from 'lucide-react';
import { TaskEvidenceSchema, type Task, type TaskEvidence } from '../shared/schema.js';
import { api } from './api.js';

export function TaskMerge({
  task,
  tasks,
  dirty,
  onMerged,
  notify,
}: {
  task: Task;
  tasks: Task[];
  dirty: boolean;
  onMerged: (evidence: TaskEvidence) => void;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [merging, setMerging] = useState(false);
  const target = tasks.find((candidate) => candidate.id === targetId);
  async function merge() {
    if (!target || dirty || merging) return;
    setMerging(true);
    try {
      const [source, destination] = await Promise.all([
        api('tasks/' + encodeURIComponent(task.id), TaskEvidenceSchema),
        api('tasks/' + encodeURIComponent(target.id), TaskEvidenceSchema),
      ]);
      const result = await api('tasks/merge', TaskEvidenceSchema, {
        source_id: task.id,
        target_id: target.id,
        source_revision: source.revision,
        target_revision: destination.revision,
      });
      onMerged(result);
      notify(task.reference + ' merged into ' + result.task.reference);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not merge these TODOs. Try again.');
    } finally {
      setMerging(false);
    }
  }
  return (
    <div className="task-merge">
      <button
        className="button secondary"
        aria-expanded={open}
        disabled={merging}
        onClick={() => setOpen(!open)}
      >
        <Link2 size={14} /> Link issue
      </button>
      {open && (
        <div className="merge-panel">
          <h3>Merge into another TODO</h3>
          <p>
            Move {task.reference}'s source messages to the correct TODO. Its old link will open the
            destination, and your original note will be kept in merge history.
          </p>
          <label htmlFor="merge-destination">Destination TODO</label>
          <select
            id="merge-destination"
            value={targetId}
            disabled={merging}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Choose the correct TODO…</option>
            {tasks
              .filter((candidate) => candidate.id !== task.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.reference} · {candidate.title}
                  {candidate.done ? ' (Completed)' : ''}
                </option>
              ))}
          </select>
          {target && (
            <p>
              The destination's title, completion status and personal note will stay the same. Both
              conversations' evidence may be used in future analysis of the combined TODO.
            </p>
          )}
          {dirty && <p>Save your note and wait for any completion change before merging.</p>}
          <button
            className="button secondary"
            disabled={!target || dirty || merging}
            onClick={() => void merge()}
          >
            {merging && <LoaderCircle size={14} className="spin" />}
            {merging ? 'Merging…' : target ? 'Merge into ' + target.reference : 'Merge TODO'}
          </button>
        </div>
      )}
    </div>
  );
}

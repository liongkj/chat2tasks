import { useState } from 'react';
import type { Message, Question, Task } from '../shared/schema.js';
import type { NoticeVariant } from '../shared/useNotice.js';
import { errorMessage } from '../shared/errors.js';
import { api, OkSchema } from './api.js';

/**
 * A completion question from WhatsApp ("did this get done?"). The owner picks
 * the task it refers to and confirms with Resolve, so a slip of the select
 * cannot tick the wrong task.
 */
export function QuestionCard({
  question,
  messages,
  tasks,
  arrived,
  notify,
  refresh,
}: {
  question: Question;
  messages: Message[];
  tasks: Task[];
  arrived: boolean;
  notify: (text: string, variant?: NoticeVariant) => void;
  refresh: () => Promise<void>;
}) {
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const message = messages.find((item) => item.id === question.message_id);
  const candidates = message
    ? tasks.filter((task) =>
        task.source_ids.some((id) =>
          messages.some(
            (source) =>
              source.id === id &&
              source.chatId === message.chatId &&
              source.sessionId === message.sessionId,
          ),
        ),
      )
    : [];
  const resolve = async (task_id: string | null) => {
    setBusy(true);
    try {
      await api('resolve', OkSchema, { id: question.id, task_id });
      await refresh();
      notify(task_id ? 'Task marked as done' : 'Question dismissed');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`question-card ${arrived ? 'question-arrived' : ''}`}>
      <h3>{question.question}</h3>
      <p>{message?.body}</p>
      <div className="form-inline">
        <select
          aria-label="Choose the completed task"
          value={taskId}
          disabled={busy}
          onChange={(event) => setTaskId(event.target.value)}
        >
          <option value="" disabled>
            Choose the completed task…
          </option>
          {candidates.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
        <button className="button" disabled={!taskId || busy} onClick={() => void resolve(taskId)}>
          Resolve
        </button>
        <button className="text-button" disabled={busy} onClick={() => void resolve(null)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

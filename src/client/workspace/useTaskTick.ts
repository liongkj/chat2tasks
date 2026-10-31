import { useEffect, useRef, useState } from 'react';
import type { Chat, Task } from '../../shared/schema.js';
import { captureCompletedRow } from '../../shared/motion.js';
import { playSound } from '../../shared/sound.js';
import { errorMessage } from '../../shared/errors.js';
import type { NoticeVariant } from '../../shared/useNotice.js';
import { api, OkSchema } from '../api.js';
import { tasksForDesk } from '../taskDesk.js';
import type { WorkspaceLocation } from '../taskLocation.js';
import type { WorkspaceData } from './useWorkspaceData.js';

export type CompletionNotice = {
  kind: 'completion';
  text: string;
  taskId: Task['id'];
  previousDone: boolean;
  done: boolean;
};

export const taskScope = (location: WorkspaceLocation) =>
  JSON.stringify([location.view, location.filter, location.kind, location.chat, location.query]);

const completionText = (task: Task, done: boolean) =>
  done
    ? task.kind === 'question'
      ? 'Question answered'
      : task.kind === 'reminder'
        ? 'Reminder dismissed'
        : 'Task completed'
    : task.kind === 'question'
      ? 'Question reopened'
      : task.kind === 'reminder'
        ? 'Reminder restored'
        : 'Task reopened';

/**
 * Optimistic completion. The row flips at once, the server is told, and a
 * failure puts the row back. Finishing the last visible task in an open desk
 * triggers the celebration for that desk only.
 */
export function useTaskTick({
  workspace,
  location,
  chats,
  notify,
  showCompletion,
}: {
  workspace: WorkspaceData;
  location: WorkspaceLocation;
  chats: Chat[];
  notify: (text: string, variant?: NoticeVariant) => void;
  showCompletion: (notice: CompletionNotice) => void;
}) {
  const { data, dataRef, refresh, refreshGate, pendingTicks, setPendingTick, setTaskDone } =
    workspace;
  const [completionFlash, setCompletionFlash] = useState<string | null>(null);
  const [celebrationScope, setCelebrationScope] = useState<string | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;
  useEffect(() => {
    if (!completionFlash && !celebrationScope) return;
    const timer = setTimeout(() => {
      setCompletionFlash(null);
      setCelebrationScope(null);
    }, 240);
    return () => clearTimeout(timer);
  }, [completionFlash, celebrationScope]);
  async function tick(task: Task, done = !task.done, source: 'direct' | 'undo' = 'direct') {
    if (pendingTicks.current.has(task.id) || task.done === done) return;
    if (done && task.gtd.recurrence) {
      setPendingTick(task.id, done);
      try {
        const result = await api('tasks/occurrence', OkSchema, {
          id: task.id,
          date: task.gtd.recurrence.next_date,
        });
        if (!result.ok)
          throw new Error('This occurrence has already changed. Refresh and try again.');
        setCompletionFlash(task.id);
        void playSound('completion', dataRef.current.sound);
        setPendingTick(task.id, null);
        await refresh();
        notify('Occurrence completed');
      } catch (error) {
        notify(errorMessage(error), 'error');
        void refresh();
      } finally {
        setPendingTick(task.id, null);
      }
      return;
    }
    const scope = taskScope(location);
    const visibleTasks = tasksForDesk({
      tasks: data.tasks,
      messages: data.messages,
      chats,
      location,
    });
    const wasLastVisible =
      done &&
      source === 'direct' &&
      location.view === 'tasks' &&
      location.filter === 'open' &&
      !location.query &&
      pendingTicks.current.size === 0 &&
      visibleTasks.length === 1 &&
      visibleTasks[0]?.id === task.id;
    const row = document
      .querySelector<HTMLElement>(`[data-task-reference="${CSS.escape(task.reference)}"]`)
      ?.closest<HTMLElement>('.task-row');
    const finishRow = captureCompletedRow(row ?? null);
    setPendingTick(task.id, done);
    setTaskDone(task.id, done);
    if (done && source === 'direct') finishRow();
    try {
      await api('tick', OkSchema, { id: task.id, done });
      refreshGate.current.invalidate();
      setPendingTick(task.id, null);
      if (done && source === 'direct') {
        setCompletionFlash(task.id);
        void playSound('completion', dataRef.current.sound);
        const currentLocation = locationRef.current;
        if (
          wasLastVisible &&
          taskScope(currentLocation) === scope &&
          tasksForDesk({
            tasks: dataRef.current.tasks.map((item) =>
              item.id === task.id ? { ...item, done } : item,
            ),
            messages: dataRef.current.messages,
            chats,
            location: currentLocation,
          }).length === 0
        )
          setCelebrationScope(scope);
      }
      showCompletion({
        kind: 'completion',
        text: completionText(task, done),
        taskId: task.id,
        previousDone: task.done,
        done,
      });
    } catch (error) {
      setPendingTick(task.id, null);
      setTaskDone(task.id, task.done);
      void refresh();
      notify(errorMessage(error), 'error');
    }
  }
  return { tick, completionFlash, celebrationScope };
}

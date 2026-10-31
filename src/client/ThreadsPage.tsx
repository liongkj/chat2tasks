import { useCallback, useEffect, useRef, useState } from 'react';
import { ThreadView } from '../shared/ThreadView.js';
import { RefreshGate } from '../shared/refresh.js';
import {
  ThreadMediaSchema,
  ThreadMoveResultSchema,
  ThreadSnapshotSchema,
  type ThreadMessage,
  type ThreadMove,
  type ThreadSnapshot,
} from '../shared/threads.js';
import type { Task } from '../shared/schema.js';
import { api, OkSchema } from './api.js';
import '../shared/thread-view.css';
import { errorMessage } from '../shared/errors.js';

export function ThreadsPage({
  onOpenTask,
  onOpenSource,
}: {
  onOpenTask: (task: Task) => void;
  onOpenSource: (message: ThreadMessage) => void;
}) {
  const [data, setData] = useState<ThreadSnapshot | null>(null),
    [error, setError] = useState('');
  const gate = useRef(new RefreshGate()),
    started = useRef(false);
  const refresh = useCallback(async () => {
    const ticket = gate.current.start();
    try {
      const next = await api('threads', ThreadSnapshotSchema);
      if (!gate.current.accept(ticket)) return;
      setData(next);
      setError('');
      if (!started.current && next.canOrganise) {
        await api('threads/enable', OkSchema, {});
        started.current = true;
      }
    } catch (e) {
      if (gate.current.accept(ticket)) setError(errorMessage(e, 'Could not load threads.'));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      clearInterval(timer);
      gate.current.invalidate();
    };
  }, [refresh]);
  async function move(input: ThreadMove) {
    gate.current.invalidate();
    const result = await api('threads/move', ThreadMoveResultSchema, input);
    await refresh();
    return result;
  }
  return (
    <div className="threads-page">
      {error && (
        <div className="inline-alert" role="alert">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && (
        <p className="empty-copy" role="status">
          Loading your threads…
        </p>
      )}
      {data && (
        <ThreadView
          data={data}
          sourceAction="View in"
          onOpenTask={onOpenTask}
          onOpenSource={onOpenSource}
          onMove={move}
          onOrganise={async () => {
            await api('threads/organise', OkSchema, {});
            await refresh();
          }}
          onMedia={async (id) =>
            (await api('threads/media/' + encodeURIComponent(id), ThreadMediaSchema)).dataUrl
          }
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PublicSettingsSchema,
  SnapshotSchema,
  defaultSoundPreferences,
  type PublicSettings,
  type Snapshot,
} from '../../shared/schema.js';
import { RefreshGate } from '../../shared/refresh.js';
import { errorMessage } from '../../shared/errors.js';
import { api } from '../api.js';

export const emptySnapshot: Snapshot = {
  demo: false,
  sound: defaultSoundPreferences,
  tasks: [],
  waiting_for: [],
  messages: [],
  questions: [],
  status: { syncing: false, phase: 'Connecting', pending: 0, error: null, debouncing: false },
  usage: { calls: 0, totalTokens: 0, model: '' },
};

/**
 * The workspace snapshot and public settings, polled from the server.
 * Optimistic ticks are kept in `pendingTicks` so a refresh that lands while a
 * tick is in flight cannot flip the row back.
 */
export function useWorkspaceData() {
  const [data, setData] = useState(emptySnapshot);
  const [config, setConfig] = useState<PublicSettings | null>(null);
  const [configError, setConfigError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [online, setOnline] = useState(true);
  const [requestingSync, setRequestingSync] = useState(false);
  const refreshGate = useRef(new RefreshGate());
  const pendingTicks = useRef(new Map<string, boolean>());
  const [pendingTickIds, setPendingTickIds] = useState<Set<string>>(new Set());
  const dataRef = useRef(data);
  dataRef.current = data;
  const refresh = useCallback(async () => {
    const ticket = refreshGate.current.start();
    try {
      const next = await api('state', SnapshotSchema);
      if (!refreshGate.current.accept(ticket)) return;
      setData({
        ...next,
        tasks: next.tasks.map((task) => {
          const pending = pendingTicks.current.get(task.id);
          return pending === undefined ? task : { ...task, done: pending };
        }),
      });
      setLoaded(true);
      setOnline(true);
    } catch {
      if (refreshGate.current.accept(ticket)) setOnline(false);
    }
  }, []);
  const refreshConfig = useCallback(async () => {
    setConfigError('');
    try {
      setConfig(await api('settings', PublicSettingsSchema));
    } catch (error) {
      setConfigError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
    void refreshConfig();
  }, [refresh, refreshConfig]);
  useEffect(() => {
    // Hidden windows skip background polling and catch up when shown again.
    const interval = data.status.syncing || data.status.debouncing || requestingSync ? 1000 : 5000;
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, interval);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, data.status.syncing, data.status.debouncing, requestingSync]);
  /** Mark a task done or open locally, bypassing any refresh already in flight. */
  const setTaskDone = useCallback((id: string, done: boolean) => {
    refreshGate.current.invalidate();
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((item) => (item.id === id ? { ...item, done } : item)),
    }));
  }, []);
  const setPendingTick = useCallback((id: string, done: boolean | null) => {
    if (done === null) pendingTicks.current.delete(id);
    else pendingTicks.current.set(id, done);
    setPendingTickIds(new Set(pendingTicks.current.keys()));
  }, []);
  return {
    data,
    dataRef,
    setData,
    config,
    setConfig,
    configError,
    loaded,
    online,
    requestingSync,
    setRequestingSync,
    refresh,
    refreshConfig,
    refreshGate,
    pendingTicks,
    pendingTickIds,
    setPendingTick,
    setTaskDone,
  };
}

export type WorkspaceData = ReturnType<typeof useWorkspaceData>;

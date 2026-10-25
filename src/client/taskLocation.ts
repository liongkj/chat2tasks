import { useCallback, useEffect, useState } from 'react';
import { TaskTriageSchema, type Task } from '../shared/schema.js';

export type TaskTab = 'overview' | 'sources';
export type TaskFilter = 'open' | 'all' | 'done' | Task['triage_state'];
export type WorkspaceView = 'conversations' | 'tasks' | 'connections' | 'settings' | 'activity';
export type WorkspaceLocation = {
  view: WorkspaceView;
  chat: string | null;
  task: string | null;
  tab: TaskTab;
  filter: TaskFilter;
  query: string;
  expanded: boolean;
};

function readLocation(): WorkspaceLocation {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const status = params.get('status');
  const state = TaskTriageSchema.shape.triage_state.safeParse(params.get('state'));
  return {
    view:
      view === 'conversations' ||
      view === 'tasks' ||
      view === 'connections' ||
      view === 'settings' ||
      view === 'activity'
        ? view
        : 'tasks',
    chat: params.get('chat'),
    task: params.get('task'),
    tab: params.get('context') === 'conversation' ? 'sources' : 'overview',
    filter: status === 'done' || status === 'all' ? status : state.success ? state.data : 'open',
    query: params.get('q') ?? '',
    expanded: params.get('panel') === 'task',
  };
}

function locationUrl(location: WorkspaceLocation) {
  const url = new URL(window.location.href);
  const values = {
    view: location.view,
    chat: location.chat,
    task: location.task,
    context: location.task && location.tab === 'sources' ? 'conversation' : null,
    status: location.filter === 'done' || location.filter === 'all' ? location.filter : null,
    state:
      location.filter === 'open' || location.filter === 'done' || location.filter === 'all'
        ? null
        : location.filter,
    q: location.query || null,
    panel: location.task && location.expanded ? 'task' : null,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url.href;
}

export function taskUrl(reference: string | null, tab: TaskTab = 'overview') {
  return locationUrl({ ...readLocation(), task: reference, tab });
}

export function useWorkspaceLocation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const restore = () => setLocation(readLocation());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const updateLocation = useCallback(
    (patch: Partial<WorkspaceLocation>, options: { replace?: boolean } = {}) => {
      const next = { ...readLocation(), ...patch };
      const url = locationUrl(next);
      if (url === window.location.href) return;
      if (options.replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
      setLocation(next);
    },
    [],
  );
  return { location, updateLocation };
}

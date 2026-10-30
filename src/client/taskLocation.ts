import { useCallback, useEffect, useState } from 'react';
import { ItemKindSchema, TaskTriageSchema, type ItemKind, type Task } from '../shared/schema.js';

export type TaskTab = 'overview' | 'sources';
export type TaskFilter = 'open' | 'all' | 'done' | Task['triage_state'];
export type ItemKindFilter = 'all' | ItemKind;
export type WorkspaceView =
  'conversations' | 'tasks' | 'threads' | 'connections' | 'settings' | 'activity';
export type WorkspaceLocation = {
  view: WorkspaceView;
  chat: string | null;
  task: string | null;
  tab: TaskTab;
  filter: TaskFilter;
  kind: ItemKindFilter;
  query: string;
  expanded: boolean;
  message?: string | null;
};

function readLocation(): WorkspaceLocation {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const status = params.get('status');
  const state = TaskTriageSchema.shape.triage_state.safeParse(params.get('state'));
  const kind = ItemKindSchema.safeParse(params.get('kind'));
  return {
    view:
      view === 'conversations' ||
      view === 'tasks' ||
      view === 'threads' ||
      view === 'connections' ||
      view === 'settings' ||
      view === 'activity'
        ? view
        : 'tasks',
    chat: params.get('chat'),
    message: params.get('message'),
    task: params.get('task'),
    tab: params.get('context') === 'conversation' ? 'sources' : 'overview',
    filter: status === 'done' || status === 'all' ? status : state.success ? state.data : 'open',
    kind: kind.success ? kind.data : 'all',
    query: params.get('q') ?? '',
    expanded: params.get('panel') === 'task',
  };
}

function locationUrl(location: WorkspaceLocation) {
  const url = new URL(window.location.href);
  const values = {
    view: location.view,
    message: location.view === 'conversations' ? (location.message ?? null) : null,
    chat: location.chat,
    task: location.task,
    context: location.task && location.tab === 'sources' ? 'conversation' : null,
    status: location.filter === 'done' || location.filter === 'all' ? location.filter : null,
    state:
      location.filter === 'open' || location.filter === 'done' || location.filter === 'all'
        ? null
        : location.filter,
    kind: location.kind === 'all' ? null : location.kind,
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
  return locationUrl({ ...readLocation(), task: reference, tab, message: null });
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

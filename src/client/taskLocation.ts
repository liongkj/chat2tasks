import { useCallback, useEffect, useState } from 'react';

export type TaskTab = 'overview' | 'sources';

function readLocation(): { task: string | null; tab: TaskTab } {
  const params = new URLSearchParams(window.location.search);
  return {
    task: params.get('task'),
    tab: params.get('context') === 'conversation' ? 'sources' : 'overview',
  };
}

export function taskUrl(reference: string | null, tab: TaskTab = 'overview') {
  const url = new URL(window.location.href);
  if (reference) url.searchParams.set('task', reference);
  else url.searchParams.delete('task');
  if (reference && tab === 'sources') url.searchParams.set('context', 'conversation');
  else url.searchParams.delete('context');
  return url.href;
}

export function useTaskLocation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const restore = () => setLocation(readLocation());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const selectTask = useCallback(
    (reference: string | null, options: { tab?: TaskTab; replace?: boolean } = {}) => {
      const url = taskUrl(reference, options.tab);
      if (url === window.location.href) return;
      if (options.replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
      setLocation(readLocation());
    },
    [],
  );
  return { location, selectTask };
}

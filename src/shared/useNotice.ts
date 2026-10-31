import { useCallback, useEffect, useRef, useState } from 'react';

export type NoticeVariant = 'info' | 'success' | 'error';
export type Notify = (text: string, variant?: NoticeVariant) => void;

export function useNotice<T>() {
  const [notice, setNotice] = useState<T | null>(null);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next: T) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setExiting(false);
    setNotice(next);
  }, []);
  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (
      document.documentElement.dataset.input !== 'pointer' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setNotice(null);
      setExiting(false);
      timer.current = null;
      return;
    }
    setExiting(true);
    timer.current = setTimeout(() => {
      setNotice(null);
      setExiting(false);
      timer.current = null;
    }, 160);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return { notice, exiting, show, dismiss };
}

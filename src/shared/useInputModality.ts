import { useEffect } from 'react';

/** Keep keyboard navigation immediate, including when it interrupts pointer motion. */
export function useInputModality() {
  useEffect(() => {
    const pointer = () => {
      document.documentElement.dataset.input = 'pointer';
    };
    const keyboard = () => {
      document.documentElement.dataset.input = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
    };
  }, []);
}

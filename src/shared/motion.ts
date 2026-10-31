/** Keep a visual-only row briefly while an optimistic completion removes it. */
export function captureCompletedRow(element: HTMLElement | null): () => void {
  if (
    !element ||
    document.documentElement.dataset.input !== 'pointer' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return () => {};
  const parent = element.parentElement;
  const bounds = element.getBoundingClientRect();
  const scrollTop = parent?.scrollTop;
  const clone = element.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return () => {};
  return () => {
    if (!parent?.isConnected || parent.scrollTop !== scrollTop || bounds.width === 0) return;
    clone.inert = true;
    clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    Object.assign(clone.style, {
      position: 'fixed',
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
      margin: '0',
      pointerEvents: 'none',
      zIndex: '80',
    });
    try {
      document.body.append(clone);
      const animation = clone.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 120,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      });
      void animation.finished.then(
        () => clone.remove(),
        () => clone.remove(),
      );
    } catch {
      clone.remove();
    }
  };
}

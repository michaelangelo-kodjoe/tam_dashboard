import { useLayoutEffect, useState, type RefObject } from 'react';

export interface PopupPos {
  top: number;
  left: number;
  minWidth: number;
  maxHeight: number;
  placement: 'below' | 'above';
}

const MARGIN = 8;

/**
 * Viewport-aware popup placement (guidelines §6.1): below by default, flips above when
 * there is less room below than the list needs and more above; clamps horizontally;
 * repositions on scroll and resize; closes (via onTrigGone) if the trigger leaves the viewport.
 */
export function useOverlayPosition(
  open: boolean,
  trigger: RefObject<HTMLElement>,
  popup: RefObject<HTMLElement>,
  deps: unknown[] = [],
  onTriggerGone?: () => void,
): PopupPos | null {
  const [pos, setPos] = useState<PopupPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const calc = () => {
      const t = trigger.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        onTriggerGone?.();
        return;
      }
      const el = popup.current;
      const natural = el ? Math.min(el.scrollHeight, 280) : 280;
      const below = window.innerHeight - r.bottom - MARGIN;
      const above = r.top - MARGIN;
      const flip = below < natural + 8 && above > below;
      const maxHeight = Math.max(80, Math.min(280, flip ? above - 4 : below - 4));
      const minWidth = r.width;
      const popW = Math.min(Math.max(el?.offsetWidth ?? minWidth, minWidth), 360);
      let left = r.left;
      if (left + popW > window.innerWidth - MARGIN) left = window.innerWidth - MARGIN - popW;
      if (left < MARGIN) left = MARGIN;
      const h = Math.min(natural, maxHeight);
      const top = flip ? r.top - h - 4 : r.bottom + 4;
      setPos({ top, left, minWidth, maxHeight, placement: flip ? 'above' : 'below' });
    };
    calc();
    window.addEventListener('resize', calc);
    window.addEventListener('scroll', calc, true);
    return () => {
      window.removeEventListener('resize', calc);
      window.removeEventListener('scroll', calc, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);

  return pos;
}

import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  text: string;
  placement?: 'bottom' | 'right';
  /** disable (e.g. rail expanded: label is already visible) */
  disabled?: boolean;
  children: ReactElement;
}

/** role=tooltip; shows after 400ms on hover, immediately on focus (guidelines §10). */
export function Tooltip({ text, placement = 'bottom', disabled, children }: Props) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>();
  const el = useRef<HTMLElement | null>(null);

  const show = () => {
    const r = el.current?.getBoundingClientRect();
    if (!r) return;
    setPos(placement === 'right' ? { x: r.right + 8, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pos]);

  if (disabled) return children;
  const c = children as ReactElement<Record<string, unknown>>;
  const child = cloneElement(c, {
    ref: (n: HTMLElement | null) => {
      el.current = n;
      const r = (c as unknown as { ref?: unknown }).ref;
      if (typeof r === 'function') r(n);
      else if (r && typeof r === 'object') (r as { current: unknown }).current = n;
    },
    'aria-describedby': pos ? id : (c.props['aria-describedby'] as string | undefined),
    onMouseEnter: (e: unknown) => {
      (c.props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(show, 400);
    },
    onMouseLeave: (e: unknown) => {
      (c.props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: unknown) => {
      (c.props.onFocus as ((e: unknown) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: unknown) => {
      (c.props.onBlur as ((e: unknown) => void) | undefined)?.(e);
      hide();
    },
  });
  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div id={id} role="tooltip" className={`tooltip tooltip--${placement}`} style={{ left: pos.x, top: pos.y }}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let lockCount = 0;

export interface OverlayProps {
  variant: 'dialog' | 'drawer';
  /** id of the element that names the overlay */
  labelledBy: string;
  onClose: () => void;
  /** Escape and scrim clicks call onClose; set false while saving. */
  closable?: boolean;
  /** scrim click closes only when the caller says it is safe (not dirty) */
  closeOnScrim?: boolean;
  /** Ctrl/Cmd+Enter */
  onSubmitShortcut?: () => void;
  width?: number;
  /** Element to focus first; default is the first focusable (or [data-autofocus]) */
  initialFocus?: 'first' | 'autofocus';
  role?: 'dialog' | 'alertdialog';
  className?: string;
  children: ReactNode;
}

/**
 * Shared modal behaviour for Dialog and Drawer (guidelines §10): aria-modal, focus trap,
 * Escape closes, focus returns to the invoker, body scroll is locked.
 */
export function Overlay({
  variant, labelledBy, onClose, closable = true, closeOnScrim = true, onSubmitShortcut, width, role = 'dialog', className, children,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // captured during the first render, before any child autoFocus moves focus
  const invoker = useRef<HTMLElement | null | undefined>(undefined);
  if (invoker.current === undefined) invoker.current = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;

  useEffect(() => {
    lockCount++;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    if (panel && !(panel.contains(document.activeElement) && document.activeElement !== panel)) {
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      const first = preferred ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }
    return () => {
      lockCount--;
      if (lockCount <= 0) {
        lockCount = 0;
        document.body.style.overflow = '';
      }
      const inv = invoker.current;
      if (inv && document.contains(inv)) inv.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      e.stopPropagation();
      if (closable) onClose();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
      e.preventDefault();
      e.stopPropagation();
      onSubmitShortcut();
      return;
    }
    if (e.key === 'Tab') {
      e.stopPropagation();
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(cur)) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className={cx('overlay', `overlay--${variant}`)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && closable && closeOnScrim) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx('overlay__panel', `overlay__panel--${variant}`, className)}
        style={width ? { width } : undefined}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

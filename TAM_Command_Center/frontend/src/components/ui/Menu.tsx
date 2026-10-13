import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from './Button';
import { useOverlayPosition } from './useOverlayPosition';
import { cx } from '../../lib/cx';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

/** Split button: primary action + chevron that opens a menu (role=menu). */
export function SplitButton({
  label, icon, items, onPrimary, onSelect, menuLabel, size = 'sm',
}: {
  label: string;
  icon?: ReactNode;
  items: MenuItem[];
  onPrimary: () => void;
  onSelect: (id: string) => void;
  menuLabel: string;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const trig = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const uid = useId();
  const close = useCallback(() => setOpen(false), []);
  const pos = useOverlayPosition(open, wrap, list, [items.length], close);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (wrap.current?.contains(n) || list.current?.contains(n)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${uid}-i${active}`)?.focus();
  }, [open, active, uid]);

  const choose = (id: string) => {
    setOpen(false);
    trig.current?.focus();
    onSelect(id);
  };

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trig.current?.focus(); }
    else if (e.key === 'Tab') { setOpen(false); }
  };

  return (
    <div ref={wrap} className="split">
      <Button variant="secondary" size={size} icon={icon} className="split__main" onClick={onPrimary}>{label}</Button>
      <Button
        ref={trig}
        variant="secondary"
        size={size}
        className="split__chev"
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setActive(0); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setActive(0); setOpen(true); } }}
        icon={<ChevronDown size={14} strokeWidth={1.5} />}
      />
      {open &&
        createPortal(
          <ul
            ref={list}
            role="menu"
            aria-label={menuLabel}
            className="popup popup--menu"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: 180, visibility: pos ? 'visible' : 'hidden' }}
            onKeyDown={onKey}
          >
            {items.map((it, i) => (
              <li key={it.id} role="none">
                <button
                  id={`${uid}-i${i}`}
                  type="button"
                  role="menuitem"
                  tabIndex={i === active ? 0 : -1}
                  className={cx('option', 'option--button', i === active && 'is-active')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(it.id)}
                >
                  {it.icon && <span className="option__icon" aria-hidden="true">{it.icon}</span>}
                  <span>{it.label}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

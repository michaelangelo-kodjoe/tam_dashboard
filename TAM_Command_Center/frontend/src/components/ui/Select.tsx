import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../../lib/cx';
import { useOverlayPosition } from './useOverlayPosition';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface SelectProps {
  value: string | null;
  onChange: (value: string | null) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Adds a "None" option at the top for nullable fields. */
  clearable?: boolean;
  clearLabel?: string;
  size?: 'sm' | 'md';
  name?: string;
  id?: string;
  disabled?: boolean;
  /** id of the visible label element */
  labelledBy?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  className?: string;
}

const CLEAR = '';
const TYPEAHEAD_MS = 500;

/** Next enabled index from `from` in direction `dir` (no wrap); returns `from` if none. */
export function stepIndex(opts: { disabled?: boolean }[], from: number, dir: 1 | -1, count = 1): number {
  let i = from;
  let moved = 0;
  let k = from;
  while (moved < count) {
    k += dir;
    if (k < 0 || k >= opts.length) break;
    if (!opts[k].disabled) {
      i = k;
      moved++;
    }
  }
  return i;
}

/**
 * Select-only combobox (WAI-ARIA APG pattern; guidelines §6.1). A hidden input mirrors
 * the value so it behaves like a form control. The popup renders in a portal.
 */
export function Select({
  value, onChange, options, placeholder = 'Select…', clearable, clearLabel = 'None', size = 'md', name, id,
  disabled, labelledBy, className, ...aria
}: SelectProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const optId = (i: number) => `${autoId}-opt-${i}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const trigRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef<{ buf: string; t: number }>({ buf: '', t: 0 });

  const all = useMemo<SelectOption[]>(
    () => (clearable ? [{ value: CLEAR, label: clearLabel }, ...options] : options),
    [clearable, clearLabel, options],
  );
  const selectedIdx = all.findIndex((o) => o.value === (value ?? CLEAR) && (value !== null || clearable));
  const selected = value === null ? null : all.find((o) => o.value === value) ?? null;

  const close = useCallback(() => setOpen(false), []);
  const pos = useOverlayPosition(open, trigRef, listRef, [all.length, active], close);

  const openAt = (idx: number) => {
    if (disabled) return;
    setActive(idx);
    setOpen(true);
  };
  const firstEnabled = () => all.findIndex((o) => !o.disabled);
  const lastEnabled = () => {
    for (let i = all.length - 1; i >= 0; i--) if (!all[i].disabled) return i;
    return -1;
  };

  const commit = (idx: number) => {
    const o = all[idx];
    if (!o || o.disabled) return;
    onChange(o.value === CLEAR ? null : o.value);
    setOpen(false);
  };

  // outside click closes without changing value
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (trigRef.current?.contains(n) || listRef.current?.contains(n)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // keep the active option visible
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const typeahead = (ch: string): number => {
    const now = Date.now();
    const ty = typed.current;
    ty.buf = now - ty.t > TYPEAHEAD_MS ? ch : ty.buf + ch;
    ty.t = now;
    const q = ty.buf.toLowerCase();
    const start = open ? active : selectedIdx;
    const order = [...all.keys()];
    // single repeated char cycles from the next option; a longer buffer searches from the start
    const rotated = ty.buf.length === 1 || [...ty.buf].every((c) => c === ty.buf[0]) ? [...order.slice(start + 1), ...order.slice(0, start + 1)] : order;
    const needle = [...ty.buf].every((c) => c === ty.buf[0]) ? ty.buf[0].toLowerCase() : q;
    return rotated.find((i) => !all[i].disabled && all[i].label.toLowerCase().startsWith(needle)) ?? -1;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      switch (k) {
        case 'ArrowDown':
          e.preventDefault();
          if (e.altKey) openAt(selectedIdx >= 0 ? selectedIdx : firstEnabled());
          else openAt(selectedIdx >= 0 ? selectedIdx : firstEnabled());
          return;
        case 'ArrowUp':
          e.preventDefault();
          openAt(selectedIdx >= 0 ? selectedIdx : firstEnabled());
          return;
        case 'Home':
          e.preventDefault();
          openAt(firstEnabled());
          return;
        case 'End':
          e.preventDefault();
          openAt(lastEnabled());
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          openAt(selectedIdx >= 0 ? selectedIdx : firstEnabled());
          return;
        default:
          if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && k !== ' ') {
            const i = typeahead(k);
            if (i >= 0) {
              e.preventDefault();
              openAt(i);
            }
          }
          return; // Escape (closed) is deliberately not consumed so a parent dialog can close.
      }
    }
    switch (k) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => stepIndex(all, a < 0 ? -1 : a, 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (e.altKey) {
          commit(active);
          return;
        }
        setActive((a) => stepIndex(all, a < 0 ? all.length : a, -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(firstEnabled());
        return;
      case 'End':
        e.preventDefault();
        setActive(lastEnabled());
        return;
      case 'PageDown':
        e.preventDefault();
        setActive((a) => stepIndex(all, a, 1, 10));
        return;
      case 'PageUp':
        e.preventDefault();
        setActive((a) => stepIndex(all, a, -1, 10));
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(active);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation?.();
        setOpen(false);
        return;
      case 'Tab':
        if (active >= 0) commit(active);
        else setOpen(false);
        return; // default focus move proceeds
      default:
        if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const i = typeahead(k);
          if (i >= 0) {
            e.preventDefault();
            setActive(i);
          }
        }
    }
  };

  return (
    <>
      <button
        ref={trigRef}
        id={id}
        type="button"
        role="combobox"
        className={cx('select', `select--${size}`, open && 'is-open', !selected && 'is-placeholder', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-labelledby={labelledBy}
        aria-label={aria['aria-label']}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid'] || undefined}
        aria-required={aria['aria-required'] || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt(selectedIdx >= 0 ? selectedIdx : firstEnabled()))}
        onKeyDown={onKeyDown}
      >
        <span className="select__value truncate">
          {selected?.icon && <span className="select__icon" aria-hidden="true">{selected.icon}</span>}
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" className="select__chev" />
      </button>
      {name && <input type="hidden" name={name} value={value ?? ''} />}
      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={labelledBy}
            aria-label={labelledBy ? undefined : aria['aria-label']}
            className="popup"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: pos?.minWidth, maxHeight: pos?.maxHeight ?? 280, visibility: pos ? 'visible' : 'hidden' }}
            // keep focus on the trigger while interacting with the list
            onMouseDown={(e) => e.preventDefault()}
          >
            {all.map((o, i) => {
              const isSel = i === selectedIdx;
              return (
                <li
                  key={o.value || '__none'}
                  id={optId(i)}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  className={cx('option', i === active && 'is-active', o.disabled && 'is-disabled')}
                  onMouseMove={() => !o.disabled && active !== i && setActive(i)}
                  onClick={() => commit(i)}
                >
                  <span className="option__check" aria-hidden="true">{isSel && <Check size={16} strokeWidth={1.5} />}</span>
                  {o.icon && <span className="option__icon" aria-hidden="true">{o.icon}</span>}
                  <span className="truncate">{o.label}</span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}

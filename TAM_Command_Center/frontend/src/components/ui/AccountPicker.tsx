import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import { cx } from '../../lib/cx';
import { useOverlayPosition } from './useOverlayPosition';

export interface PickerAccount {
  id: string;
  name: string;
  bpid: string | null;
  status: 'Active' | 'Inactive';
}

export interface AccountPickerProps {
  accounts: PickerAccount[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Adds a top "No account" option (task editor). */
  nullable?: boolean;
  placeholder?: string;
  id?: string;
  labelledBy?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Jump mode: the input is cleared after a selection and shows a search icon. */
  jump?: boolean;
  className?: string;
  size?: 'sm' | 'md';
  inputRef?: RefObject<HTMLInputElement>;
  /** Called when the user chooses an account in jump mode, after the field clears. */
}

const NONE = '__none__';

export function filterAccounts(accounts: PickerAccount[], text: string): PickerAccount[] {
  const q = text.trim().toLowerCase();
  const matched = q ? accounts.filter((a) => a.name.toLowerCase().includes(q) || (a.bpid ?? '').toLowerCase().includes(q)) : accounts;
  // Inactive accounts appear last, each group alphabetical.
  return [...matched].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'Active' ? -1 : 1));
}

function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  const i = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <strong className="option__match">{text.slice(i, i + needle.length)}</strong>
      {text.slice(i + needle.length)}
    </>
  );
}

/** Editable combobox with list autocomplete (APG; guidelines §6.3). */
export function AccountPicker({
  accounts, value, onChange, nullable, placeholder = 'Search accounts…', id, labelledBy, disabled, autoFocus, jump, className, size = 'md', ...aria
}: AccountPickerProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const optId = (i: number) => `${autoId}-opt-${i}`;
  const selected = accounts.find((a) => a.id === value) ?? null;
  const selectedLabel = selected ? selected.name : '';
  const [text, setText] = useState(jump ? '' : selectedLabel);
  const [typed, setTyped] = useState(false); // user edited the text => filter
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = aria.inputRef ?? ownRef;
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // keep the text in sync when the value changes from outside
  useEffect(() => {
    if (!typed && !jump) setText(selectedLabel);
  }, [selectedLabel, typed, jump]);

  const results = useMemo(() => filterAccounts(accounts, typed ? text : ''), [accounts, text, typed]);
  type Row = { key: string; acc: PickerAccount | null };
  const rows: Row[] = useMemo(
    () => [...(nullable ? [{ key: NONE, acc: null }] : []), ...results.map((a) => ({ key: a.id, acc: a }))],
    [results, nullable],
  );

  const close = useCallback(() => setOpen(false), []);
  const pos = useOverlayPosition(open, wrapRef, listRef, [rows.length, active], close);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (wrapRef.current?.contains(n) || listRef.current?.contains(n)) return;
      revert();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedLabel, jump]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function revert() {
    setTyped(false);
    setText(jump ? '' : selectedLabel);
  }

  function choose(row: Row | undefined) {
    if (!row) return;
    onChange(row.acc ? row.acc.id : null);
    setTyped(false);
    setText(jump ? '' : row.acc ? row.acc.name : '');
    setOpen(false);
    setActive(-1);
  }

  const move = (dir: 1 | -1) => {
    if (!open) {
      setOpen(true);
      setActive(dir === 1 ? 0 : rows.length - 1);
      return;
    }
    setActive((a) => Math.min(rows.length - 1, Math.max(0, a < 0 ? (dir === 1 ? 0 : rows.length - 1) : a + dir)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'Enter':
        if (open && active >= 0) {
          e.preventDefault();
          e.stopPropagation();
          choose(rows[active]);
        }
        return;
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation?.();
          if (text !== '') {
            setText('');
            setTyped(true);
            setActive(-1);
          } else {
            revert();
            setOpen(false);
          }
        } else if (text !== '' && !jump) {
          // closed with text: let a parent dialog handle Escape
        }
        return;
      case 'Tab':
        if (open && active >= 0) choose(rows[active]);
        else {
          revert();
          setOpen(false);
        }
        return;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        return;
      case 'End':
        if (open) {
          e.preventDefault();
          setActive(rows.length - 1);
        }
    }
  };

  return (
    <div ref={wrapRef} className={cx('picker', `picker--${size}`, jump && 'picker--jump', className)}>
      {jump && <Search size={16} strokeWidth={1.5} className="picker__icon" aria-hidden="true" />}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        className="input picker__input"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-labelledby={labelledBy}
        aria-label={aria['aria-label']}
        aria-describedby={aria['aria-describedby']}
        aria-invalid={aria['aria-invalid'] || undefined}
        aria-required={aria['aria-required'] || undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        value={text}
        onFocus={(e) => {
          if (!jump) e.currentTarget.select();
          else setOpen(true);
        }}
        onClick={() => !disabled && setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setTyped(true);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={(e) => {
          // focus moved out of the widget (not into the popup, which never takes focus)
          if (wrapRef.current?.contains(e.relatedTarget as Node)) return;
          if (!typed) return;
          if (!jump && nullable && text.trim() === '') onChange(null);
          revert();
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Accounts"
            className="popup popup--picker"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: Math.max(pos?.minWidth ?? 0, 280), maxHeight: pos?.maxHeight ?? 280, visibility: pos ? 'visible' : 'hidden' }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((r, i) => {
              const isSel = r.acc ? r.acc.id === value : value === null;
              return (
                <li
                  key={r.key}
                  id={optId(i)}
                  role="option"
                  aria-selected={isSel}
                  className={cx('option', i === active && 'is-active')}
                  onMouseMove={() => active !== i && setActive(i)}
                  onClick={() => choose(r)}
                >
                  <span className="option__check" aria-hidden="true">{isSel && !jump && <Check size={16} strokeWidth={1.5} />}</span>
                  {r.acc ? (
                    <>
                      <span className="truncate">
                        <Highlight text={r.acc.name} q={typed ? text : ''} />
                      </span>
                      {r.acc.bpid && (
                        <span className="option__meta mono">
                          <Highlight text={r.acc.bpid} q={typed ? text : ''} />
                        </span>
                      )}
                      {r.acc.status === 'Inactive' && <span className="option__tag">Inactive</span>}
                    </>
                  ) : (
                    <span className="muted">No account</span>
                  )}
                </li>
              );
            })}
            {results.length === 0 && (
              <li role="presentation" className="popup__empty">
                No accounts match
              </li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

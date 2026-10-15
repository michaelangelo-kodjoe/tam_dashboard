import { useRef, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';

export interface StripItem<T extends string> { id: T; label: string; count?: number }

/** role=tablist of filter tabs with roving tabindex; Left/Right/Home/End move and select (APG tabs, automatic activation). */
export function TabStrip<T extends string>({ items, value, onChange, label, variant = 'seg' }: { items: StripItem<T>[]; value: T; onChange: (id: T) => void; label: string; variant?: 'seg' | 'chips' }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n >= 0) { e.preventDefault(); onChange(items[n].id); refs.current[n]?.focus(); }
  };
  return (
    <div role="tablist" aria-label={label} className={variant === 'seg' ? 'bm-seg' : 'bm-ftabs'}>
      {items.map((it, i) => {
        const on = it.id === value;
        return (
          <button key={it.id} ref={(el) => (refs.current[i] = el)} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
            className={variant === 'seg' ? cx('bm-seg__btn', on && 'is-on') : 'bm-ftab'} onClick={() => onChange(it.id)} onKeyDown={(e) => onKey(e, i)}>
            {it.label}{it.count !== undefined && <span className={cx('num', variant === 'seg' && 'bm-seg__n')}>{it.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

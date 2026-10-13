import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number | null;
}

interface Props {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  /** prefix for ids; tab = `${idPrefix}-tab-${id}`, panel = `${idPrefix}-panel` */
  idPrefix: string;
}

/** APG tabs, automatic activation, arrow/Home/End navigation. The caller renders the tabpanel. */
export function Tabs({ items, value, onChange, label, idPrefix }: Props) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n >= 0) {
      e.preventDefault();
      refs.current[n]?.focus();
      onChange(items[n].id);
    }
  };
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {items.map((t, i) => {
        const sel = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => (refs.current[i] = el)}
            id={`${idPrefix}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={sel}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={sel ? 0 : -1}
            className={cx('tab', sel && 'is-selected')}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.icon && <span className="tab__icon" aria-hidden="true">{t.icon}</span>}
            <span>{t.label}</span>
            {t.count != null && <span className="tab__count num">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

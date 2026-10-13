import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface Props<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  /** Accessible name for the radiogroup */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** role=radiogroup with roving tabindex; arrows move AND select (guidelines §6.2). */
export function SegmentedControl<T extends string>({ value, onChange, options, label, size = 'md', className }: Props<T>) {
  const gid = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = options.findIndex((o) => o.value === value);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = options.length - 1;
    if (n >= 0) {
      e.preventDefault();
      onChange(options[n].value);
      refs.current[n]?.focus();
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx('segmented', `segmented--${size}`, className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            id={`${gid}-${i}`}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (idx < 0 && i === 0) ? 0 : -1}
            className={cx('segmented__item', checked && 'is-checked')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.icon && <span aria-hidden="true" className="segmented__icon">{o.icon}</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

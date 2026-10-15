import { useId, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

/** role=switch toggle (native-free, dark). The label is always visible text or aria-label. */
export function Switch({ checked, onChange, label, 'aria-label': ariaLabel, disabled, className, describedBy }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  'aria-label'?: string;
  disabled?: boolean;
  className?: string;
  describedBy?: string;
}) {
  const id = useId();
  return (
    <span className={cx('switch', className)}>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={label ? undefined : ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        className={cx('switch__track', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" aria-hidden="true" />
      </button>
      {label && <label htmlFor={id} className="switch__label">{label}</label>}
    </span>
  );
}

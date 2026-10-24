import { forwardRef, useEffect, useId, useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Button } from './Button';
import { addDays } from '../../lib/dates';
import { cx } from '../../lib/cx';

export interface FieldProps {
  label: string;
  required?: boolean;
  error?: string | null;
  hint?: ReactNode;
  /** receives ids to wire onto the control */
  children: (ids: { id: string; labelId: string; describedBy?: string; invalid: boolean; required: boolean }) => ReactNode;
  className?: string;
  /** keep the label for assistive tech only (the page supplies a visible one) */
  hideLabel?: boolean;
}

/** Visible label above, error linked with aria-describedby (guidelines §7). */
export function Field({ label, required, error, hint, children, className, hideLabel }: FieldProps) {
  const uid = useId();
  const id = `${uid}-c`;
  const labelId = `${uid}-l`;
  const errId = `${uid}-e`;
  const hintId = `${uid}-h`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('field', error && 'has-error', className)}>
      <label id={labelId} htmlFor={id} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
        {required && <span className="field__req" aria-hidden="true"> *</span>}
      </label>
      {children({ id, labelId, describedBy, invalid: !!error, required: !!required })}
      {hint && <p id={hintId} className="field__hint">{hint}</p>}
      {error && <p id={errId} className="field__error">{error}</p>}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function TextInput(
  { className, invalid, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('input', className)} aria-invalid={invalid || undefined} {...rest} />;
});

/** Grows from 3 to 12 rows (guidelines §7). */
export function TextArea({ className, invalid, value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = 20;
    const max = line * 12 + 14;
    const min = line * 3 + 14;
    el.style.height = `${Math.min(max, Math.max(min, el.scrollHeight))}px`;
  }, [value]);
  useEffect(() => undefined, []);
  return <textarea ref={ref} className={cx('input textarea', className)} aria-invalid={invalid || undefined} value={value} rows={3} {...rest} />;
}

/** Native date input (dark colour-scheme, D-15) plus Today / Tomorrow / +1 week chips. */
export function DateField({
  value, onChange, today, id, invalid, describedBy, required, clearable = true, ariaLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  today: string;
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
  clearable?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="datefield">
      <input
        id={id}
        type="date"
        className="input datefield__input num"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        aria-label={ariaLabel}
      />
      <div className="datefield__chips">
        <Button size="sm" variant="ghost" onClick={() => onChange(today)}>Today</Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(addDays(today, 1))}>Tomorrow</Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(addDays(today, 7))}>+1 week</Button>
        {clearable && value && <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Clear</Button>}
      </div>
    </div>
  );
}

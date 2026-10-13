import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check } from 'lucide-react';

/** Real <input type=checkbox> (visually hidden) + custom dark box. Never the native control. */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }>(function Checkbox(
  { label, className, ...rest },
  ref,
) {
  return (
    <label className={`check ${className ?? ''}`}>
      <input ref={ref} type="checkbox" className="check__input" {...rest} />
      <span className="check__box" aria-hidden="true">
        <Check size={12} strokeWidth={2.5} />
      </span>
      <span className="check__label">{label}</span>
    </label>
  );
});

// Shared presentational pieces of the import review and the Add account similar-account panel.
// Strength is always a WORD with its reasons (D-42); nothing numeric is ever shown.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cx } from '../../lib/cx';
import { StatusBadge, type Tone } from '../ui/Badges';
import type { FillMap, KeptMap, MatchStrength, ReasonText, SimilarCandidate } from '../../types';
import { FIELD_LABEL } from './importState';

const STRENGTH_TONE: Record<MatchStrength, Tone> = { High: 'warning', Medium: 'info', Low: 'neutral' };

export function StrengthBadge({ strength }: { strength: MatchStrength }) {
  return <StatusBadge value={strength} tone={STRENGTH_TONE[strength]}>{strength} match</StatusBadge>;
}

export const dash = (v: string | null | undefined): ReactNode => (v ? v : <span className="subtle">-</span>);

export function Facts({ c }: { c: Pick<SimilarCandidate, 'bpid' | 'products' | 'status' | 'next_contact'> }) {
  return (
    <p className="imp-facts muted sm">
      <span>BPID <span className="mono">{dash(c.bpid)}</span></span>
      <span>{dash(c.products)}</span>
      <span>{c.status ?? '-'}</span>
      <span>Next contact <span className="num">{dash(c.next_contact)}</span></span>
    </p>
  );
}

export function Reasons({ reasons, differences }: { reasons: ReasonText[]; differences?: ReasonText[] }) {
  return (
    <ul className="imp-reasons" aria-label="Why it was flagged">
      {reasons.map((r) => <li key={r.code + r.text}>{r.text}</li>)}
      {(differences ?? []).map((r) => <li key={r.code + r.text} className="muted">{r.text}</li>)}
    </ul>
  );
}

export function FillKeep({ fills, kept, notes }: { fills: FillMap; kept: KeptMap; notes?: string[] }) {
  const f = Object.entries(fills);
  const k = Object.entries(kept).filter(([, v]) => v.differs !== false); // equal values need no mention
  return (
    <div className="imp-fill" aria-label="If same account">
      <div className="label">If Same account</div>
      <p className="muted sm">Only blanks are filled; existing values are never overwritten.</p>
      {f.length === 0 && <p className="muted sm">Nothing to fill. Every value in the file is empty or already set.</p>}
      <ul className="imp-kv">
        {f.map(([key, v]) => (
          <li key={key}><span className="muted">{FIELD_LABEL[key] ?? key}</span><span className="imp-kv__v">{v}</span><span className="badge badge--info">Fills blank</span></li>
        ))}
        {k.map(([key, v]) => (
          <li key={key}>
            <span className="muted">{FIELD_LABEL[key] ?? key}</span>
            <span className="imp-kv__v muted">{v.existing} kept{v.file ? `; file says ${v.file}` : ''}</span>
            <span className="badge badge--neutral">Kept</span>
          </li>
        ))}
      </ul>
      {(notes ?? []).map((n) => <p key={n} className="sm muted">{n}</p>)}
    </div>
  );
}

/** A labelled radiogroup of buttons with a roving tabindex. `value` may be null (nothing chosen). */
export function RadioList<T extends string>({
  label, value, onChange, options, className,
}: { label: string; value: T | null; onChange: (v: T) => void; options: { value: T; label: ReactNode; sub?: ReactNode; disabled?: boolean }[]; className?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const cur = options.findIndex((o) => o.value === value);
  const tab = cur >= 0 && !options[cur].disabled ? cur : enabled[0] ?? -1;
  const onKey = (e: KeyboardEvent, i: number) => {
    const pos = enabled.indexOf(i);
    let n = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') n = enabled[0];
    else if (e.key === 'End') n = enabled[enabled.length - 1];
    if (n >= 0) { e.preventDefault(); refs.current[n]?.focus(); onChange(options[n].value); }
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('imp-radios', className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={o.disabled || undefined}
            tabIndex={i === tab ? 0 : -1}
            className={cx('imp-radio', checked && 'is-checked', o.disabled && 'is-disabled')}
            onClick={() => { if (!o.disabled) onChange(o.value); }}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="imp-radio__mark" aria-hidden="true">{checked && <Check size={12} strokeWidth={2} />}</span>
            <span className="imp-radio__text"><span>{o.label}</span>{o.sub && <span className="muted sm">{o.sub}</span>}</span>
          </button>
        );
      })}
    </div>
  );
}

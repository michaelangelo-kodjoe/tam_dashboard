// Run 2 instruments (docs/02_DESIGN_GUIDELINES.md §15.4): static inline SVG/CSS, no gradients, no animation,
// no chart library. Every instrument carries a text equivalent. Colours come only from CSS classes (tokens).
import { useRef, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';
import { initials, meterLabel, type Meter } from '../../lib/instruments';
import type { ChipDef } from '../../lib/triage';

export type InstrumentTone = 'danger' | 'warning' | 'info' | 'accent' | 'neutral';

// ------------------------------------------------------------------ meter / stack bar

export function StackBar({ meter, className, thin }: { meter: Meter; className?: string; thin?: boolean }) {
  const seg = [
    { k: 'overdue', n: meter.overdue },
    { k: 'waiting', n: meter.waiting },
    { k: 'other', n: meter.other },
  ].filter((s) => s.n > 0);
  return (
    <div className={cx('stackbar', thin && 'stackbar--thin', className)} role="img" aria-label={meterLabel(meter)}>
      {seg.map((s) => <i key={s.k} className={`seg seg--${s.k}`} style={{ flexGrow: s.n }} />)}
    </div>
  );
}

export function MeterLegend({ meter }: { meter: Meter }) {
  return (
    <p className="legend" title="A task that is both overdue and Waiting is counted once in the bar, under Overdue.">
      <span><i className="swatch seg--overdue" aria-hidden="true" />Overdue {meter.overdue}</span>
      <span><i className="swatch seg--waiting" aria-hidden="true" />Waiting {meter.waiting}</span>
      <span><i className="swatch seg--other" aria-hidden="true" />Other {meter.other}</span>
    </p>
  );
}

// ------------------------------------------------------------------ sparkline

export function Sparkline({ values, label, tone = 'neutral', width = 120, height = 30, className }: {
  values: number[]; label: string; tone?: InstrumentTone; width?: number; height?: number; className?: string;
}) {
  if (values.length < 2) return <span className="subtle sm">No trend data</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => `${((i * width) / (values.length - 1)).toFixed(1)},${(height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1)}`);
  return (
    <svg className={cx('spark', `spark--${tone}`, className)} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{label}</title>
      <polyline points={pts.join(' ')} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ------------------------------------------------------------------ progress ring

export function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const complete = total > 0 && done >= total;
  return (
    <svg className="ring" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <circle className="ring__track" cx="22" cy="22" r={r} />
      <circle className="ring__arc" cx="22" cy="22" r={r} strokeDasharray={`${(frac * c).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 22 22)" />
      {complete && <path className="ring__check" d="M15 22.5l5 5 9-10" fill="none" />}
    </svg>
  );
}

// ------------------------------------------------------------------ summary chips

export function SummaryChips({ chips, value, onChange, label }: { chips: ChipDef[]; value: string; onChange: (id: ChipDef['id']) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = chips.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
  const move = (from: number, dir: 1 | -1) => {
    const at = enabled.indexOf(from);
    const next = enabled[(at + dir + enabled.length) % enabled.length];
    if (next === undefined) return;
    refs.current[next]?.focus();
    onChange(chips[next].id);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(i, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i, -1); }
  };
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {chips.map((c, i) => {
        const checked = c.id === value;
        return (
          <button
            key={c.id}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={c.disabled || undefined}
            tabIndex={checked ? 0 : -1}
            className={cx('chip', checked && 'is-checked', c.disabled && 'is-empty')}
            onClick={() => { if (!c.disabled) onChange(c.id); }}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="chip__label">{c.label}</span>
            <b className="chip__count num">{c.count}</b>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ dot row

export function DotRow({ dots, label, square, max = 12, className }: { dots: { tone: InstrumentTone | null; name?: string }[]; label: string; square?: boolean; max?: number; className?: string }) {
  const shown = dots.slice(0, max);
  const extra = dots.length - shown.length;
  if (dots.length === 0) return <span className="subtle">-</span>;
  return (
    <span className={cx('dotrow', square && 'dotrow--sq', className)} role="img" aria-label={label}>
      {shown.map((d, i) => <i key={i} className={cx('dotrow__dot', d.tone && `dotrow__dot--${d.tone}`)} title={d.name} />)}
      {extra > 0 && <span className="dotrow__more num">+{extra}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ avatar, pill, proximity track

export function Avatar({ name }: { name: string }) {
  return <span className="avatar" aria-hidden="true">{initials(name)}</span>;
}

export function DatePill({ pill }: { pill: { date: string; rel: string; overdue: boolean; today: boolean } | null }) {
  if (!pill) return <span className="subtle">-</span>;
  return (
    <span className={cx('pill num', pill.today && 'pill--today')}>
      {pill.date}
      {pill.today ? <em className="pill__rel pill__rel--today">Today</em> : pill.rel && <em className={cx('pill__rel', pill.overdue && 'pill__rel--overdue')}>{pill.rel}</em>}
    </span>
  );
}

export function ProximityTrack({ pct, label, tone = 'info' }: { pct: number; label: string; tone?: 'info' | 'accent' }) {
  return (
    <div className="proxtrack" role="img" aria-label={label}>
      <i className={`proxtrack__fill proxtrack__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

import type { ReactNode } from 'react';
import { Hourglass } from 'lucide-react';
import { cx } from '../../lib/cx';
import { diffDays, formatDate, relativeLabel } from '../../lib/dates';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<string, Tone> = {
  // task status
  'Not Started': 'neutral', 'In Progress': 'info', Waiting: 'warning', Complete: 'success',
  // upgrade status
  Planned: 'neutral', Scheduled: 'neutral', 'Awaiting Client': 'warning', 'Validation Required': 'warning',
  Completed: 'success', Deferred: 'neutral', Exception: 'danger',
  // validation
  Pending: 'warning', Passed: 'success', Failed: 'danger', 'Not Required': 'neutral',
  // account status
  Inactive: 'neutral', Active: 'success',
  // freshness
  Live: 'success', Delayed: 'warning', Stale: 'danger', 'No Data': 'neutral', Disabled: 'neutral',
};

export function toneOf(value: string): Tone {
  return TONES[value] ?? 'neutral';
}

/** One mapping used everywhere (guidelines §4). Text is always present, never colour alone. */
export function StatusBadge({ value, tone, children }: { value: string; tone?: Tone; children?: ReactNode }) {
  const t = tone ?? toneOf(value);
  return (
    <span className={cx('badge', `badge--${t}`)}>
      {value === 'Waiting' && <Hourglass size={12} strokeWidth={1.5} aria-hidden="true" />}
      {children ?? value}
    </span>
  );
}

export function SeverityBadge({ severity, status }: { severity: string; status?: string }) {
  if (status === 'recovered') return <span className="badge badge--neutral">Recovered · close pending</span>;
  const tone: Tone = severity === 'Critical' ? 'danger' : severity === 'Warning' ? 'warning' : 'info';
  return <span className={cx('badge', `badge--${tone}`)}>{severity}</span>;
}

export function PriorityLabel({ value }: { value: string | null }) {
  if (!value) return <span className="subtle">-</span>;
  const glyph = value === 'High' ? '▲' : value === 'Medium' ? '●' : '▽';
  const cls = value === 'High' ? 'prio prio--high' : value === 'Medium' ? 'prio prio--med' : 'prio prio--low';
  return (
    <span className={cls}>
      <span aria-hidden="true" className="prio__glyph">{glyph}</span>
      {value}
    </span>
  );
}

/** Absolute date + relative label next to it (guidelines §13). */
export function DateCell({ date, today, kind = 'due', showRelative = true }: { date: string | null | undefined; today: string; kind?: 'due' | 'plain'; showRelative?: boolean }) {
  if (!date) return <span className="subtle">-</span>;
  const delta = diffDays(date.slice(0, 10), today);
  const rel = relativeLabel(delta);
  const cls = kind === 'due' && rel.overdue ? 'danger-text' : kind === 'due' && rel.today ? 'accent-text' : undefined;
  return (
    <span className="datecell num">
      <span className={cls}>{formatDate(date, today)}</span>
      {showRelative && <span className={cx('datecell__rel', kind === 'due' && rel.overdue && 'danger-text')}>{rel.text}</span>}
    </span>
  );
}

export function Count({ value }: { value: number }) {
  return <span className={cx('num', value === 0 && 'subtle')}>{value}</span>;
}


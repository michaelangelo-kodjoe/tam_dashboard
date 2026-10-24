import { memo } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, MinusCircle, type LucideIcon } from 'lucide-react';
import type { BamsFreshness, BamsRow, DisplayStatus, Severity } from '../../bamsTypes';
import { cx } from '../../lib/cx';
import { STATUS_LABEL } from '../../lib/bams';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const DISPLAY: Record<Exclude<DisplayStatus, 'disabled'>, { tone: Tone; icon: LucideIcon }> = {
  open: { tone: 'danger', icon: AlertCircle },
  recovered: { tone: 'warning', icon: AlertTriangle },
  stale: { tone: 'warning', icon: AlertTriangle },
  no_data: { tone: 'neutral', icon: MinusCircle },
  delayed: { tone: 'warning', icon: Clock },
  live: { tone: 'success', icon: CheckCircle2 },
};

/** Status is always a word plus an icon, never colour alone (mockup 01). */
const SEV_TONE: Record<Severity, Tone> = { Critical: 'danger', Warning: 'warning', Info: 'info' };
/** Tone for an alert row edge/badge: the alert's severity (Warning amber, Critical red). */
export const severityTone = (s: Severity): Tone => SEV_TONE[s];

export function StatusBadge({ status, label, severity }: { status: DisplayStatus; label?: string; /** alert severity colours open/recovered badges (text always present) */ severity?: Severity }) {
  if (status === 'disabled') return <span className="badge badge--neutral">Disabled</span>;
  const d = severity && (status === 'open' || status === 'recovered') ? { ...DISPLAY[status], tone: SEV_TONE[severity] } : DISPLAY[status];
  const Icon = d.icon;
  return (
    <span className={cx('badge', `badge--${d.tone}`, 'bm-status')}>
      <Icon size={12} strokeWidth={1.5} aria-hidden="true" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

const FRESH_STATUS: Record<BamsFreshness, DisplayStatus> = { Live: 'live', Delayed: 'delayed', Stale: 'stale', 'No Data': 'no_data' };
export const FreshnessBadge = ({ freshness }: { freshness: BamsFreshness }) => <StatusBadge status={FRESH_STATUS[freshness]} />;

/** Alert badge (if any) plus the freshness badge, as in mockup 01. */
export function RowStatus({ row }: { row: BamsRow }) {
  return (
    <span className="bm-badges">
      {row.alert && <StatusBadge status={row.alert.status === 'open' ? 'open' : 'recovered'} severity={row.alert.severity} label={`${STATUS_LABEL[row.alert.status === 'open' ? 'open' : 'recovered']} · ${row.alert.severity}`} />}
      <FreshnessBadge freshness={row.freshness} />
    </span>
  );
}

export function SimulatedBadge() {
  return <span className="badge badge--info bm-sim" title="Values come from the DEV simulator, not Bloomberg.">SIMULATED</span>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={cx('badge', `badge--${SEV_TONE[severity]}`)}>{severity}</span>;
}

/** 72x18 polyline, aria-hidden (the current value and trend text carry the information). */
export const Spark = memo(function Spark({ points, tone }: { points: number[]; tone?: 'danger' }) {
  if (points.length < 2) return <span className="subtle" aria-hidden="true" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 72;
  const h = 18;
  const pts = points.map((v, i) => `${((i / (points.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="bm-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={tone === 'danger' ? 'var(--danger)' : 'var(--muted)'} strokeWidth="1.2" />
    </svg>
  );
});

/** Loading-safe percent cell: "91.4%" or "No data". */
export function Value({ value }: { value: number | null }) {
  return value == null ? <span className="subtle">No data</span> : <b>{value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</b>;
}

// Pure BAMS helpers shared by the pages and the mock adapter. All metric values are
// percentages (user decision, contract §11.12 0e): they are always shown with a % sign.
import type { BamsRow, BamsHigh, DisplayStatus, Operator, ReferencePeriod, RuleType, Severity } from '../bamsTypes';
import { pad2, parseInstant, timeOfDay, type TimeDisplay } from './dates';

export function formatValue(n: number | null | undefined): string {
  if (n == null) return '';
  return `${n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
/** Plain number for rule sentences (no % sign): 85, 1,755, 0.5. */
export function formatPlain(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

export function formatAge(sec: number | null | undefined): string {
  if (sec == null) return 'never';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${pad2(s % 60)} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} m`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

export function formatSeconds(s: number): string {
  if (s % 3600 === 0 && s >= 3600) return `${s / 3600} h`;
  if (s % 60 === 0 && s >= 120) return `${s / 60} min`;
  return `${s} s`;
}

/** Time of day in the user's local time zone, 12-hour am/pm by default (setting only decides 12/24 hour). */
export function formatTime(instant: string | null | undefined, _tz: TimeDisplay = 'local', seconds = false): string {
  if (!instant) return 'never';
  const d = parseInstant(instant);
  if (Number.isNaN(d.getTime())) return 'never';
  return timeOfDay(d, seconds);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "14 Oct 2:02 PM" (local) */
export function formatStamp(instant: string | null | undefined, _tz: TimeDisplay = 'local'): string {
  if (!instant) return '';
  const d = parseInstant(instant);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${timeOfDay(d)}`;
}
/** "3 Oct" from a YYYY-MM-DD date. */
export function formatHighDate(date: string | null | undefined): string {
  if (!date) return '';
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  open: 'Open alert', recovered: 'Recovered, awaiting close', stale: 'Stale', no_data: 'No data', delayed: 'Delayed', live: 'Live', disabled: 'Disabled',
};
export const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, Warning: 1, Info: 2 };

export const RULE_TYPE_LABEL: Record<RuleType, string> = { fixed_threshold: 'Threshold', pct_of_high: 'Percent of high', exceeds_high: 'Historical high' };
export const OPERATOR_LABEL: Record<Operator, string> = { '>': 'Greater than (>)', '>=': 'Greater than or equal (>=)', '<': 'Less than (<)', '<=': 'Less than or equal (<=)' };
export const PERIOD_LABEL: Record<ReferencePeriod, string> = { '30d': '30-day high', '60d': '60-day high', '90d': '90-day high' };

export interface RuleLike {
  rule_type: RuleType; operator?: Operator; threshold: number | null; reference_period: ReferencePeriod | null; consecutive_updates: number; severity: Severity;
}

function highOf(highs: BamsRow['highs'] | undefined, p: ReferencePeriod | null): BamsHigh | null {
  if (!highs || !p) return null;
  return p === '30d' ? highs.d30 : p === '60d' ? highs.d60 : highs.d90;
}
const periodDays = (p: ReferencePeriod | null) => (p ? Number(p.slice(0, -1)) : 90);

/** The sentence from contract §11.1 `Rule.preview`, computed locally so the editor can preview unsaved edits. */
export function rulePreview(metricName: string, r: RuleLike, highs?: BamsRow['highs']): string {
  const n = `${r.consecutive_updates} ${r.consecutive_updates === 1 ? 'update' : 'updates'}`;
  const hv = highOf(highs, r.reference_period)?.value;
  const hi = hv != null ? ` (${formatPlain(hv)})` : '';
  if (r.rule_type === 'fixed_threshold') return `Alerts when ${metricName} ${r.operator ?? '>'} ${r.threshold == null ? '…' : formatPlain(r.threshold)} for ${n} (${r.severity})`;
  if (r.rule_type === 'pct_of_high') return `Alerts when ${metricName} ${r.operator ?? '>'} ${r.threshold == null ? '…' : formatPlain(r.threshold)}% of the ${periodDays(r.reference_period)}-day high${hi} for ${n} (${r.severity})`;
  return `Alerts when ${metricName} exceeds the ${periodDays(r.reference_period)}-day high${hi} for ${n} (${r.severity})`;
}

/** Short condition for the rules table: "> 85", "> 90% of 90-day high", "exceeds 90-day high". */
export function ruleCondition(r: RuleLike): string {
  if (r.rule_type === 'fixed_threshold') return `${r.operator ?? '>'} ${r.threshold == null ? '' : formatPlain(r.threshold)}`.trim();
  if (r.rule_type === 'pct_of_high') return `${r.operator ?? '>'} ${r.threshold == null ? '' : formatPlain(r.threshold)}% of ${periodDays(r.reference_period)}-day high`;
  return `exceeds ${periodDays(r.reference_period)}-day high`;
}

/** The level a rule compares against (for trend reference lines and the mock still-breaching check). */
export function ruleLevel(r: RuleLike, highs: BamsRow['highs']): number | null {
  if (r.rule_type === 'fixed_threshold') return r.threshold;
  const h = highOf(highs, r.reference_period)?.value;
  if (h == null) return null;
  return r.rule_type === 'pct_of_high' ? (h * (r.threshold ?? 0)) / 100 : h;
}
export function breaches(op: Operator, value: number, level: number): boolean {
  return op === '>' ? value > level : op === '>=' ? value >= level : op === '<' ? value < level : value <= level;
}

/** Case-insensitive GLOB (`*` and `?`), as the starter templates' metric_match (contract §11.8). */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(text);
}


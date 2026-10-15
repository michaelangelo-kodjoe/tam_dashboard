// Pure Operations helpers: derivation (parity with the backend, contract section 13), selection, grouping.
import type { OpsGroup, OpsQuarter, OpsRow, OpsSummary } from '../opsTypes';
import { OPS_STATUSES } from '../opsTypes';

export const MAX_SELECT = 500;

export interface DeriveInput {
  environment: 'PROD' | 'DEV' | null; polarity: 'East' | 'West' | null; quarter: OpsQuarter; override: string | null;
}
export interface DerivedDate { effective: string | null; source: 'quarter' | 'override' | 'none'; derived: string | null; reason: string | null }

/** Quarter date for an appliance (D-111) plus the specific "Not set" reason. */
export function deriveDate({ environment, polarity, quarter, override }: DeriveInput): DerivedDate {
  let derived: string | null = null;
  let reason: string | null = null;
  if (environment === 'DEV') {
    derived = quarter.dev_date;
    if (!derived) reason = `No DEV date in ${quarter.label}`;
  } else if (environment === 'PROD') {
    if (polarity === 'East') { derived = quarter.east_prod_date; if (!derived) reason = `No PROD East date in ${quarter.label}`; }
    else if (polarity === 'West') { derived = quarter.west_prod_date; if (!derived) reason = `No PROD West date in ${quarter.label}`; }
    else reason = 'Set East or West';
  } else reason = 'Set Environment (PROD or DEV)';
  if (override) return { effective: override, source: 'override', derived, reason: null };
  return { effective: derived, source: derived ? 'quarter' : 'none', derived, reason: derived ? null : reason };
}

export function deriveVersion(own: string | null, quarterDefault: string | null): OpsRow['version'] {
  if (own) return { effective: own, source: 'appliance', own, quarter_default: quarterDefault };
  if (quarterDefault) return { effective: quarterDefault, source: 'quarter', own: null, quarter_default: quarterDefault };
  return { effective: null, source: 'none', own: null, quarter_default: quarterDefault };
}

export function isOverdue(date: string | null, status: string, today: string): boolean {
  return !!date && date < today && status !== 'Completed' && status !== 'Deferred';
}

/** D-114: quarter with the earliest date on/after today, else the latest quarter. */
export function defaultQuarter(quarters: OpsQuarter[], today: string): OpsQuarter | null {
  if (!quarters.length) return null;
  let best: { q: OpsQuarter; d: string } | null = null;
  for (const q of quarters) {
    for (const d of [q.dev_date, q.east_prod_date, q.west_prod_date]) if (d && d >= today && (!best || d < best.d)) best = { q, d };
  }
  if (best) return best.q;
  return [...quarters].sort((a, b) => a.year * 4 + Number(a.quarter[1]) - (b.year * 4 + Number(b.quarter[1])))[quarters.length - 1];
}

export function summarize(rows: OpsRow[]): OpsSummary {
  const by: Record<string, number> = Object.fromEntries(OPS_STATUSES.map((s) => [s, 0]));
  let overdue = 0;
  for (const r of rows) { by[r.status] = (by[r.status] ?? 0) + 1; if (r.overdue) overdue++; }
  return { total: rows.length, by_status: by, overdue };
}

/** "6 appliances: 3 Planned, 2 Scheduled, 1 Overdue" (status counts first, zero counts omitted). */
export function summaryText(count: number, s: OpsSummary): string {
  const parts: string[] = [];
  for (const [k, n] of Object.entries(s.by_status)) if (n > 0) parts.push(`${n} ${k}`);
  if (s.overdue > 0) {
    const at = parts.findIndex((x) => /^\d+ (Completed|Deferred)$/.test(x));
    parts.splice(at < 0 ? parts.length : at, 0, `${s.overdue} Overdue`);
  }
  return `${count} ${count === 1 ? 'appliance' : 'appliances'}${parts.length ? ': ' + parts.join(', ') : ''}`;
}

// ---- selection (D-119) -------------------------------------------------------------------
export type Tri = 'none' | 'some' | 'all';
export function triState(ids: string[], selected: ReadonlySet<string>): Tri {
  if (!ids.length) return 'none';
  const n = ids.filter((i) => selected.has(i)).length;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}
/** Click on a tri-state: all selected -> clear them; otherwise select them all. */
export function toggleGroup(ids: string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (triState(ids, selected) === 'all') ids.forEach((i) => next.delete(i));
  else ids.forEach((i) => next.add(i));
  return next;
}
export function allIds(groups: OpsGroup[]): string[] { return groups.flatMap((g) => g.rows.map((r) => r.object_id)); }
export function groupIds(g: OpsGroup): string[] { return g.rows.map((r) => r.object_id); }

// ---- expand state (D-120) ----------------------------------------------------------------
export function filtersActive(f: { q: string; status: string | null; environment: string | null; polarity: string | null }): boolean {
  return !!(f.q.trim() || f.status || f.environment || f.polarity);
}
export function isExpanded(clientId: string, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>, active: boolean): boolean {
  return active ? !collapsed.has(clientId) : expanded.has(clientId);
}

// Metric navigation tree for Alert configuration (mockup 08, revised): account (client) groups at the top
// level, appliances nested inside, metrics inside those. One master toggle opens/closes every account group.
import type { BamsRow, Severity } from '../bamsTypes';
import { SEVERITY_ORDER } from './bams';

export interface ApplianceNode { id: string; name: string; rows: BamsRow[]; worst: Severity | null }
export interface AccountNode { id: string; name: string; appliances: ApplianceNode[]; count: number; worst: Severity | null }

/** Worst severity among active (open or recovered, not closed) alerts; null when nothing is alerting. */
export function worstSeverity(rows: BamsRow[]): Severity | null {
  let w: Severity | null = null;
  for (const r of rows) {
    const s = r.alert && r.alert.status !== 'closed' ? r.alert.severity : null;
    if (s && (w == null || SEVERITY_ORDER[s] < SEVERITY_ORDER[w])) w = s;
  }
  return w;
}

export const rowMatches = (r: BamsRow, q: string): boolean => {
  const t = q.trim().toLowerCase();
  return !t || `${r.object.client_name} ${r.object.name} ${r.metric_name}`.toLowerCase().includes(t);
};

/** Group rows by account then appliance (names sorted, metrics keep input order). The filter keeps matching metrics only. */
export function buildMetricTree(rows: BamsRow[], filter = ''): AccountNode[] {
  const accounts = new Map<string, { name: string; appl: Map<string, ApplianceNode> }>();
  for (const r of rows) {
    if (!rowMatches(r, filter)) continue;
    let a = accounts.get(r.object.client_id);
    if (!a) { a = { name: r.object.client_name, appl: new Map() }; accounts.set(r.object.client_id, a); }
    let o = a.appl.get(r.object.id);
    if (!o) { o = { id: r.object.id, name: r.object.name, rows: [], worst: null }; a.appl.set(r.object.id, o); }
    o.rows.push(r);
  }
  const byName = (x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true });
  return [...accounts.entries()].map(([id, a]) => {
    const appliances = [...a.appl.values()].map((o) => ({ ...o, worst: worstSeverity(o.rows) })).sort(byName);
    return { id, name: a.name, appliances, count: appliances.reduce((n, o) => n + o.rows.length, 0), worst: worstSeverity(appliances.flatMap((o) => o.rows)) };
  }).sort(byName);
}

// ---- master toggle memory (localStorage; every access guarded) ----
const KEY = 'tam.bams.metricTree.open';
/** Collapsed by default; remembered until the user changes it. */
export function loadMasterOpen(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function saveMasterOpen(open: boolean): void {
  try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* memory only */ }
}

export interface OpenState { master: boolean; /** per-account overrides of the master value */ overrides: Record<string, boolean>; filtering: boolean; selectedAccountId?: string | null }
/** While filtering every matching group is open. Otherwise: explicit override, else the selected metric's account, else master. */
export function isAccountOpen(id: string, s: OpenState): boolean {
  if (s.filtering) return true;
  if (id in s.overrides) return s.overrides[id];
  if (s.selectedAccountId === id) return true;
  return s.master;
}

// BAMS table grouped by account: summary text, default open state, session memory. No scores or percentages.
import type { BamsRow } from '../bamsTypes';

const ORDER: [BamsRow['display_status'], string][] = [
  ['open', 'open alert'], ['recovered', 'recovered'], ['stale', 'stale'], ['delayed', 'delayed'], ['no_data', 'no data'],
];

/** "12 appliances · 2 stale · 1 no data"; "all live" when nothing needs attention. */
export function groupSummary(rows: BamsRow[]): string {
  const objs = new Set(rows.map((r) => r.object.id)).size;
  const parts = ORDER.map(([k, label]) => [rows.filter((r) => r.display_status === k).length, label] as const).filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  const tail = parts.length ? parts.join(' · ') : 'all live';
  return `${objs} ${objs === 1 ? 'appliance' : 'appliances'} · ${tail}`;
}

/** Accounts with an active (open or recovered-awaiting-close) alert start expanded. */
export function hasActiveAlert(rows: BamsRow[]): boolean {
  return rows.some((r) => r.display_status === 'open' || r.display_status === 'recovered' || r.active_alerts > 0);
}

const KEY = 'tam.bams.groups';
export function loadGroupState(): Record<string, boolean> {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}
export function saveGroupState(s: Record<string, boolean>): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* session memory only */ }
}

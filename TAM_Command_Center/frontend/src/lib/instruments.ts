// Pure derivations behind the Run 2 instruments (docs/01_PM_SPEC.md §10.4, D-31, D-33). No React, no colours.
import type { AccountSummary, QueueItem, ServerTile, ServerUpgrade, Task } from '../types';
import { addDays, diffDays, formatDate, relativeLabel } from './dates';

// ------------------------------------------------------------------ meters (#1, #13, #15)

export interface Meter { open: number; overdue: number; waiting: number; other: number }

const isOpen = (t: Task) => !t.archived && t.status !== 'Complete';

/** Mutually exclusive segments in the order Overdue, then Waiting (not overdue), then Other (§10.4 #1). */
export function meterOf(tasks: Task[], today: string): Meter {
  let overdue = 0, waiting = 0, other = 0;
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    if (t.due != null && t.due < today) overdue++;
    else if (t.status === 'Waiting') waiting++;
    else other++;
  }
  return { open: overdue + waiting + other, overdue, waiting, other };
}

export const meterLabel = (m: Meter) => `${m.open} open: ${m.overdue} overdue, ${m.waiting} waiting, ${m.other} other`;

export function meterByClient(tasks: Task[], today: string): Map<string, Meter> {
  const by = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.client_id) continue;
    const l = by.get(t.client_id) ?? [];
    l.push(t);
    by.set(t.client_id, l);
  }
  return new Map([...by].map(([id, l]) => [id, meterOf(l, today)]));
}

// ------------------------------------------------------------------ header cells (#2, #3, #4)

export interface ServerSummary { total: number; prod: number; dev: number; unknown: number; warning: number; critical: number }
export function serverSummary(tiles: ServerTile[]): ServerSummary {
  const s: ServerSummary = { total: tiles.length, prod: 0, dev: 0, unknown: 0, warning: 0, critical: 0 };
  for (const t of tiles) {
    if (t.environment === 'PROD') s.prod++;
    else if (t.environment === 'DEV') s.dev++;
    else s.unknown++;
    if (t.alert_severity === 'Warning') s.warning++;
    if (t.alert_severity === 'Critical') s.critical++;
  }
  return s;
}

const SEV_RANK: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
/** Highest-severity open alert, then earliest opened (§10.4 #3). Recovered alerts rank after open ones. */
export function worstAlert(queue: QueueItem[], clientId: string): QueueItem | null {
  const alerts = queue.filter((i) => i.kind === 'bams_alert' && i.client_id === clientId);
  alerts.sort((a, b) =>
    (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
    (SEV_RANK[a.severity ?? ''] ?? 9) - (SEV_RANK[b.severity ?? ''] ?? 9) ||
    (a.date ?? '').localeCompare(b.date ?? ''));
  return alerts[0] ?? null;
}

/** D-34: the highest-ranked queue item (tiers 1-5) for the account, taken from the same queue so it can never disagree with Today. */
export function topItemFor(queue: QueueItem[], clientId: string): QueueItem | null {
  return queue.find((i) => i.client_id === clientId && i.tier != null && i.tier <= 5) ?? null;
}

/** Proximity track: the closer the date, the fuller (30-day scale); overdue and today are full. */
export function proximityPct(date: string | null, today: string): number {
  if (!date) return 0;
  const d = diffDays(date, today);
  return Math.round((Math.max(0, Math.min(30, 30 - d)) / 30) * 100);
}

export function openUpgradeCount(upgrades: ServerUpgrade[]): number {
  return upgrades.filter((u) => u.status !== 'Completed' && u.status !== 'Deferred').length;
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s.]/gu, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].replace('.', '')[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0].replace('.', '')[1] ?? '');
  return (first + last).toUpperCase();
}

/** "CPU Utilization (%)" -> "CPU"; "Disk Usage (%)" -> "Disk". Already-short names pass through. */
export function shortMetric(name: string): string {
  return name.split(/[\s(]/)[0] || name;
}

export function sparkWindowLabel(hours: number): string {
  return hours <= 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// ------------------------------------------------------------------ Accounts page (#12 to #16, #19)

export interface Portfolio { active: number; overdue: number; alerts: number; clear: number }
/** Counts of ACCOUNTS; an account with both counts in both, so the three need not sum (#12). */
export function portfolio(accounts: AccountSummary[]): Portfolio {
  const act = accounts.filter((a) => a.status === 'Active');
  const overdue = act.filter((a) => a.overdue > 0).length;
  const alerts = act.filter((a) => a.active_alerts > 0).length;
  return { active: act.length, overdue, alerts, clear: act.filter((a) => a.overdue === 0 && a.active_alerts === 0).length };
}

/** Top 6 by overdue desc, open desc, then name (same order as Account Load) (#13). */
export function loadLeaders(accounts: AccountSummary[], n = 6): AccountSummary[] {
  return accounts
    .filter((a) => a.status === 'Active')
    .sort((a, b) => b.overdue - a.overdue || b.open_tasks - a.open_tasks || a.name.localeCompare(b.name))
    .slice(0, n);
}

export interface DayCell { date: string; upgrades: number; touches: number }
export const CAL_DAYS = 15;
/** Day cells T..T+14: upgrade markers from non-Completed/Deferred upgrades, contact markers from Active next_contact (#14). */
export function nextDays(accounts: AccountSummary[], upgradeDates: string[], today: string): { cells: DayCell[]; upgrades: number; touches: number } {
  const cells: DayCell[] = Array.from({ length: CAL_DAYS }, (_, i) => ({ date: addDays(today, i), upgrades: 0, touches: 0 }));
  let upgrades = 0, touches = 0;
  for (const d of upgradeDates) {
    const i = diffDays(d, today);
    if (i >= 0 && i < CAL_DAYS) { cells[i].upgrades++; upgrades++; }
  }
  for (const a of accounts) {
    if (a.status !== 'Active' || !a.next_contact) continue;
    const i = diffDays(a.next_contact, today);
    if (i >= 0 && i < CAL_DAYS) { cells[i].touches++; touches++; }
  }
  return { cells, upgrades, touches };
}

/** Upgrade dates in the T..T+14 window from the Today queue (tier 5 covers exactly that window). */
export function upgradeDatesFromQueue(queue: QueueItem[], today: string): string[] {
  const hi = addDays(today, CAL_DAYS - 1);
  return queue
    .filter((i) => i.kind === 'server_upgrade' && i.date && i.status !== 'Completed' && i.status !== 'Deferred' && i.date >= today && i.date <= hi)
    .map((i) => i.date!);
}

export interface AccountSignals {
  critical: boolean;
  /** days overdue of the oldest overdue upgrade, 0 when none */
  upgradeOverdueDays: number;
  overdueTasks: number;
  warning: boolean;
  /** client touch due today or overdue: days late (0 = today), null when not due */
  touchLateDays: number | null;
  alertServers: Map<string, 'Critical' | 'Warning' | 'Info'>;
}

export function signalsFromQueue(accounts: AccountSummary[], queue: QueueItem[], today: string): Map<string, AccountSignals> {
  const out = new Map<string, AccountSignals>();
  for (const a of accounts) {
    out.set(a.id, {
      critical: false, upgradeOverdueDays: 0, overdueTasks: a.overdue, warning: false,
      touchLateDays: a.next_contact && a.next_contact <= today ? diffDays(today, a.next_contact) : null,
      alertServers: new Map(),
    });
  }
  for (const i of queue) {
    const s = i.client_id ? out.get(i.client_id) : undefined;
    if (!s) continue;
    if (i.kind === 'bams_alert' && i.status === 'open') {
      if (i.severity === 'Critical') s.critical = true;
      if (i.severity === 'Warning') s.warning = true;
      if (i.server_name && i.severity) {
        const prev = s.alertServers.get(i.server_name.toLowerCase());
        if (!prev || SEV_RANK[i.severity] < SEV_RANK[prev]) s.alertServers.set(i.server_name.toLowerCase(), i.severity);
      }
    }
    if (i.kind === 'server_upgrade' && i.tier === 1 && i.days_delta != null && i.days_delta < 0) {
      s.upgradeOverdueDays = Math.max(s.upgradeOverdueDays, -i.days_delta);
    }
  }
  return out;
}

export interface AttentionRow { id: string; name: string; reason: string; tone: 'danger' | 'warning' }

/** D-33. Key: critical, overdue upgrade, overdue tasks desc, warning, touch due, name. Max 4. No score. */
export function needsAttention(accounts: AccountSummary[], signals: Map<string, AccountSignals>, max = 4): AttentionRow[] {
  const rows = accounts
    .filter((a) => a.status === 'Active')
    .map((a) => ({ a, s: signals.get(a.id) }))
    .filter((x): x is { a: AccountSummary; s: AccountSignals } => !!x.s)
    .filter(({ s }) => s.critical || s.upgradeOverdueDays > 0 || s.overdueTasks > 0 || s.warning || s.touchLateDays != null);
  rows.sort((x, y) =>
    Number(y.s.critical) - Number(x.s.critical) ||
    Number(y.s.upgradeOverdueDays > 0) - Number(x.s.upgradeOverdueDays > 0) ||
    y.s.overdueTasks - x.s.overdueTasks ||
    Number(y.s.warning) - Number(x.s.warning) ||
    Number(y.s.touchLateDays != null) - Number(x.s.touchLateDays != null) ||
    x.a.name.localeCompare(y.a.name));
  return rows.slice(0, max).map(({ a, s }) => {
    const reasons: string[] = [];
    if (s.critical) reasons.push('Critical alert');
    if (s.upgradeOverdueDays > 0) reasons.push(`upgrade ${s.upgradeOverdueDays}d overdue`);
    if (s.overdueTasks > 0) reasons.push(`${s.overdueTasks} overdue ${s.overdueTasks === 1 ? 'task' : 'tasks'}`);
    if (s.warning) reasons.push('Warning alert');
    if (s.touchLateDays != null) reasons.push(s.touchLateDays === 0 ? 'client touch due today' : `client touch ${s.touchLateDays}d overdue`);
    return { id: a.id, name: a.name, reason: reasons.slice(0, 2).join(', '), tone: s.critical || s.upgradeOverdueDays > 0 ? 'danger' : 'warning' };
  });
}

/** Pill text for Next upgrade / Next contact cells. */
export function pillOf(date: string | null, today: string): { date: string; rel: string; overdue: boolean; today: boolean } | null {
  if (!date) return null;
  const r = relativeLabel(diffDays(date, today));
  return { date: formatDate(date, today), rel: r.today ? '' : r.text, overdue: r.overdue, today: r.today };
}

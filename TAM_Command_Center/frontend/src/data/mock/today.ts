// In-memory port of db/queries/today_queue.sql (PM §3.1, D-04, D-05, D-23, D-24).
// "First qualifying tier only" is structural: each object kind gets ONE tier via an
// ordered if-chain, mirroring the SQL CASE expressions. Horizon constants live here.
import type { QueueItem, TaskPriority, Urgency } from '../../types';
import { addDays, diffDays, instantLocalDate } from '../../lib/dates';
import type { Row, Tables } from './rebase';

export const HORIZON = {
  upgradeQueueDays: 14, // tier 5 window
  upcomingTaskNearDays: 3, // tier 6 window
  upcomingTaskFarDays: 14,
  upcomingTouchDays: 14,
  upcomingUpgradeFromDays: 15,
  upcomingUpgradeToDays: 30,
} as const;

export const TIER_LABELS: Record<number, string> = {
  1: 'Overdue / Critical',
  2: 'Due today',
  3: 'Infrastructure alerts',
  4: 'Waiting / follow-up',
  5: 'Upgrade actions',
  6: 'Upcoming tasks',
};

const PRIO: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const SEV: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
const lt = (a: string | null | undefined, b: string) => a != null && a < b;
const eq = (a: string | null | undefined, b: string) => a != null && a === b;
const between = (a: string | null | undefined, lo: string, hi: string) => a != null && a >= lo && a <= hi;

interface Internal extends QueueItem {
  _isUpcoming: boolean;
  _prio: number;
  _sev: number;
  _validation: string | null;
}

export interface TodayRanked {
  queue: QueueItem[];
  upcoming: QueueItem[];
}

export function rankToday(t: Tables, today: string): TodayRanked {
  const t1 = addDays(today, 1);
  const t3 = addDays(today, HORIZON.upcomingTaskNearDays);
  const t4 = addDays(today, HORIZON.upcomingTaskNearDays + 1);
  const t14 = addDays(today, HORIZON.upcomingTaskFarDays);
  const t15 = addDays(today, HORIZON.upcomingUpgradeFromDays);
  const t30 = addDays(today, HORIZON.upcomingUpgradeToDays);
  const tUp = addDays(today, HORIZON.upgradeQueueDays);

  const clients = new Map<string, Row>(t.clients.map((c) => [c.id, c]));
  const items: Internal[] = [];

  // ------------------------------------------------------------ tasks
  for (const tk of t.tasks) {
    if (tk.archived || tk.status === 'Complete') continue;
    const c = tk.client_id ? clients.get(tk.client_id) : undefined;
    if (tk.client_id && (!c || c.status !== 'Active')) continue;

    let tier: number | null = null;
    if (lt(tk.due, today)) tier = 1;
    else if (eq(tk.due, today)) tier = 2;
    else if (tk.status === 'Waiting' && (tk.next_update == null || tk.next_update <= today)) tier = 4;
    else if (between(tk.due, t1, t3)) tier = 6;

    const isTouchTask = tk.category === 'Client Follow-Up' && tk.due != null && c != null && tk.due === c.next_contact;
    let upcomingKind: 'due' | 'next_update' | null = null;
    if (between(tk.due, t4, t14)) upcomingKind = 'due';
    else if (tk.status === 'Waiting' && tk.next_update != null && tk.next_update > today && tk.next_update <= t14)
      upcomingKind = 'next_update';

    const itemDate = tier === 4 ? tk.next_update : tier != null ? tk.due : upcomingKind === 'due' ? tk.due : tk.next_update;
    const dateKind = tier === 4 ? 'next_update' : tier != null ? 'due' : upcomingKind;
    const context = isTouchTask
      ? 'Next Client Touch'
      : tk.status === 'Waiting' && tk.waiting != null
        ? `Waiting: ${tk.waiting}`
        : null;
    items.push({
      kind: 'task', id: tk.id, tier, tier_label: null, client_id: tk.client_id ?? null, client_name: c?.name ?? null,
      type_label: 'Task', title: tk.task, status: tk.status, priority: tk.priority as TaskPriority, severity: null,
      urgency: 'upcoming', date: itemDate ?? null, date_kind: (dateKind ?? null) as QueueItem['date_kind'],
      days_delta: null, context, server_name: null,
      _isUpcoming: upcomingKind != null, _prio: PRIO[tk.priority] ?? 3, _sev: 3, _validation: null,
    });
  }

  // ------------------------------------------------------------ client touches (D-23)
  for (const c of t.clients) {
    if (c.status !== 'Active' || c.next_contact == null) continue;
    const suppressed = t.tasks.some(
      (ft) => ft.client_id === c.id && !ft.archived && ft.status !== 'Complete' && ft.category === 'Client Follow-Up' && ft.due === c.next_contact,
    );
    if (suppressed) continue;
    const primary = t.contacts.find((ct) => ct.client_id === c.id && ct.is_primary);
    items.push({
      kind: 'client_follow_up', id: c.id, tier: c.next_contact <= today ? 4 : null, tier_label: null,
      client_id: c.id, client_name: c.name, type_label: 'Client touch', title: 'Next client touch', status: c.status,
      priority: null, severity: null, urgency: 'follow_up', date: c.next_contact, date_kind: 'next_contact', days_delta: null,
      context: primary ? `With ${primary.name}` : null, server_name: null,
      _isUpcoming: c.next_contact > today && c.next_contact <= addDays(today, HORIZON.upcomingTouchDays),
      _prio: 3, _sev: 3, _validation: null,
    });
  }

  // ------------------------------------------------------------ BAMS alerts
  const metrics = new Map<string, Row>(t.bams_metrics.map((m) => [m.id, m]));
  const objects = new Map<string, Row>(t.bams_objects.map((o) => [o.id, o]));
  for (const e of t.bams_alert_events) {
    if (e.status !== 'open' && e.status !== 'recovered') continue;
    const m = metrics.get(e.metric_id);
    const o = m && objects.get(m.object_id);
    const c = o && clients.get(o.client_id);
    if (!m || !o || !c || c.status !== 'Active' || !o.enabled || !m.enabled) continue;
    items.push({
      kind: 'bams_alert', id: e.id, tier: e.status === 'open' && e.severity === 'Critical' ? 1 : 3, tier_label: null,
      client_id: o.client_id, client_name: c.name, type_label: 'BAMS alert', title: `${o.name} · ${m.metric_name}`,
      status: e.status, priority: null, severity: e.severity, urgency: 'alert', date: e.opened_at, date_kind: 'opened',
      days_delta: null, context: e.message ?? null, server_name: o.name,
      _isUpcoming: false, _prio: 3, _sev: SEV[e.severity] ?? 3, _validation: null,
    });
  }

  // ------------------------------------------------------------ server upgrades (D-24)
  for (const u of t.server_upgrades) {
    const c = clients.get(u.client_id);
    if (!c || c.status !== 'Active') continue;
    if (u.status === 'Completed' && (u.validation_status === 'Passed' || u.validation_status === 'Not Required')) continue;
    let tier: number | null = null;
    if (lt(u.scheduled_date, today) && u.status !== 'Completed' && u.status !== 'Deferred') tier = 1;
    else if (
      u.status !== 'Deferred' &&
      ((between(u.scheduled_date, today, tUp) && u.status !== 'Completed') ||
        u.status === 'Validation Required' ||
        u.status === 'Exception' ||
        u.validation_status === 'Failed' ||
        (u.status === 'Completed' && u.validation_status === 'Pending'))
    )
      tier = 5;
    items.push({
      kind: 'server_upgrade', id: u.id, tier, tier_label: null, client_id: u.client_id, client_name: c.name,
      type_label: 'Server upgrade',
      title: `${u.server_name} ${u.current_version ?? '?'} → ${u.target_version ?? '?'}`,
      status: u.status, priority: null, severity: null, urgency: 'upgrade', date: u.scheduled_date ?? null,
      date_kind: 'scheduled', days_delta: null,
      context: `${u.environment} ${u.polarity} · validation ${u.validation_status}${u.waiting_on ? ` · waiting on ${u.waiting_on}` : ''}`,
      server_name: u.server_name,
      _isUpcoming: between(u.scheduled_date, t15, t30) && u.status !== 'Completed',
      _prio: 3, _sev: 3, _validation: u.validation_status,
    });
  }

  // ------------------------------------------------------------ finalize
  const kept = items.filter((i) => i.tier != null || i._isUpcoming);
  for (const i of kept) {
    i.tier_label = i.tier != null ? TIER_LABELS[i.tier] : null;
    i.urgency = urgencyOf(i);
    if (i.date) {
      const day = i.date_kind === 'opened' ? instantLocalDate(i.date) : i.date.slice(0, 10);
      i.days_delta = diffDays(day, today);
    }
  }
  kept.sort(compare);
  const strip = ({ _isUpcoming, _prio, _sev, _validation, ...rest }: Internal): QueueItem => {
    void _isUpcoming; void _prio; void _sev; void _validation;
    return rest;
  };
  return {
    queue: kept.filter((i) => i.tier != null).map(strip),
    upcoming: kept.filter((i) => i.tier == null).map(strip),
  };
}

function urgencyOf(i: Internal): Urgency {
  if (i.tier == null) return 'upcoming';
  if (i.tier === 1) return i.kind === 'bams_alert' ? 'critical' : 'overdue';
  if (i.tier === 2) return 'due_today';
  if (i.tier === 3) return i.status === 'recovered' ? 'recovered' : 'alert';
  if (i.tier === 4) return i.kind === 'client_follow_up' ? 'follow_up' : 'waiting';
  if (i.tier === 5) {
    const val = i.status === 'Validation Required' || i._validation === 'Failed' || (i.status === 'Completed' && i._validation === 'Pending');
    return val ? 'validation' : 'upgrade';
  }
  return 'upcoming';
}

// Sort keys mirror the SQL ORDER BY (k1..k4, then kind, id). NULL dates sort last (QA-1-11a).
function keys(i: Internal): (number | string)[] {
  const tier = i.tier;
  const dateNull = i.date == null ? 1 : 0;
  const k1 = tier === 1 ? (i.kind !== 'bams_alert' ? 1 : 0) : tier === 2 ? i._prio : tier === 3 ? (i.status !== 'open' ? 1 : 0) : tier === 4 ? dateNull : 0;
  const k2 = tier === 1 ? i._prio : tier === 3 ? i._sev : 0;
  const k3a = tier === 2 ? 0 : dateNull;
  const k3b = tier === 2 ? i.title : (i.date ?? '');
  const k4 = tier === 6 ? i._prio : 0;
  return [tier == null ? 0 : tier, k1, k2, k3a, k3b, k4, i.kind, i.id];
}

function compare(a: Internal, b: Internal): number {
  const aUp = a.tier == null ? 1 : 0;
  const bUp = b.tier == null ? 1 : 0;
  if (aUp !== bUp) return aUp - bUp;
  const ka = keys(a);
  const kb = keys(b);
  for (let n = 0; n < ka.length; n++) {
    if (ka[n] < kb[n]) return -1;
    if (ka[n] > kb[n]) return 1;
  }
  return 0;
}

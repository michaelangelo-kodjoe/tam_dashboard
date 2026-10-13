// Pure derivations over (rebased) mock tables: account summaries, infrastructure,
// BAMS freshness (frozen mock clock), and activity sentences. Mirrors
// db/queries/account_summary.sql, metric_freshness.sql and docs/03_DATA_MODEL.md §7.
import type {
  AccountSummary,
  Account,
  BamsObject,
  Contact,
  Freshness,
  Infrastructure,
  InfrastructureSummary,
  Note,
  ServerUpgrade,
  Task,
} from '../../types';
import { formatDate } from '../../lib/dates';
import type { Row, Tables } from './rebase';

export const toAccount = (r: Row): Account => ({
  id: r.id,
  name: r.name,
  status: r.status,
  bpid: r.bpid ?? null,
  products: r.products ?? null,
  last_contact: r.last_contact ?? null,
  next_contact: r.next_contact ?? null,
  notes: r.notes ?? null,
  created_at: r.created_at,
  updated_at: r.updated_at,
  row_version: r.row_version,
});

export const toContact = (r: Row): Contact => ({
  id: r.id,
  client_id: r.client_id,
  name: r.name,
  role: r.role ?? null,
  email: r.email ?? null,
  team: r.team ?? null,
  is_primary: !!r.is_primary,
  created_at: r.created_at,
  updated_at: r.updated_at,
  row_version: r.row_version,
});

export const toTask = (r: Row): Task => ({
  id: r.id,
  task: r.task,
  client_id: r.client_id ?? null,
  category: r.category,
  priority: r.priority,
  due: r.due ?? null,
  next_update: r.next_update ?? null,
  status: r.status,
  waiting: r.waiting ?? null,
  notes: r.notes ?? null,
  archived: !!r.archived,
  created_at: r.created_at,
  updated_at: r.updated_at,
  row_version: r.row_version,
});

export const toNote = (r: Row): Note => ({
  id: r.id,
  client_id: r.client_id,
  note_type: r.note_type,
  timestamp: r.timestamp,
  subject: r.subject ?? null,
  body: r.body ?? null,
  action_items: r.action_items ?? null,
  source: r.source,
  created_at: r.created_at,
  updated_at: r.updated_at,
  row_version: r.row_version,
});

export const toUpgrade = (r: Row): ServerUpgrade => ({
  id: r.id,
  client_id: r.client_id,
  server_name: r.server_name,
  environment: r.environment,
  polarity: r.polarity,
  schedule_year: r.schedule_year ?? null,
  schedule_quarter: r.schedule_quarter ?? null,
  current_version: r.current_version ?? null,
  target_version: r.target_version ?? null,
  scheduled_date: r.scheduled_date ?? null,
  maintenance_window: r.maintenance_window ?? null,
  status: r.status,
  validation_status: r.validation_status,
  waiting_on: r.waiting_on ?? null,
  reference: r.reference ?? null,
  notes: r.notes ?? null,
  updated_at: r.updated_at,
  row_version: r.row_version,
});

// ------------------------------------------------------------------ freshness

/**
 * Freshness band at the FROZEN mock clock (docs/03_DATA_MODEL.md §8). `clock` is the
 * load instant used for rebasing; the live wall clock is deliberately never used.
 */
export function freshnessOf(metric: Row, object: Row, clock: Date): Freshness {
  if (!object.enabled || !metric.enabled) return 'Disabled';
  if (metric.last_received == null) return 'No Data';
  const ageS = (clock.getTime() - Date.parse(metric.last_received)) / 1000;
  if (ageS <= 75) return 'Live';
  if (ageS <= (metric.stale_after_seconds ?? 120)) return 'Delayed';
  return 'Stale';
}

const WORST_ORDER: Exclude<Freshness, 'Disabled'>[] =['Stale', 'No Data', 'Delayed', 'Live'];

export function worstStatus(statuses: Freshness[]): Freshness {
  const monitored = statuses.filter((s) => s !== 'Disabled');
  if (monitored.length === 0) return 'Disabled';
  for (const w of WORST_ORDER) if (monitored.includes(w)) return w;
  return 'Live';
}

// ------------------------------------------------------------------ summaries

const norm = (s: string) => s.trim().toLowerCase();

function activeAlertCount(t: Tables, clientId: string): number {
  const objs = new Map(t.bams_objects.filter((o) => o.client_id === clientId).map((o) => [o.id, o]));
  const metrics = new Map(t.bams_metrics.filter((m) => objs.has(m.object_id)).map((m) => [m.id, m]));
  return t.bams_alert_events.filter((e) => {
    if (e.status !== 'open' && e.status !== 'recovered') return false;
    const m = metrics.get(e.metric_id);
    if (!m) return false;
    const o = objs.get(m.object_id);
    return !!o && !!o.enabled && !!m.enabled;
  }).length;
}

export function accountSummary(t: Tables, c: Row, today: string): AccountSummary {
  const tasks = t.tasks.filter((x) => x.client_id === c.id && !x.archived);
  const open = tasks.filter((x) => x.status !== 'Complete');
  const ups = t.server_upgrades
    .filter((u) => u.client_id === c.id && u.scheduled_date != null && u.scheduled_date >= today && u.status !== 'Completed' && u.status !== 'Deferred')
    .sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : 1));
  const servers = new Set<string>();
  for (const o of t.bams_objects) if (o.client_id === c.id) servers.add(norm(o.name));
  for (const u of t.server_upgrades) if (u.client_id === c.id) servers.add(norm(u.server_name));
  return {
    ...toAccount(c),
    open_tasks: open.length,
    overdue: open.filter((x) => x.due != null && x.due < today).length,
    waiting: tasks.filter((x) => x.status === 'Waiting').length,
    active_alerts: activeAlertCount(t, c.id),
    next_upgrade: ups[0]?.scheduled_date ?? null,
    upcoming_upgrades: ups.length,
    servers: servers.size,
  };
}

export function infrastructureSummary(t: Tables, clientId: string, today: string): InfrastructureSummary {
  const objs = t.bams_objects.filter((o) => o.client_id === clientId);
  const ups = t.server_upgrades.filter((u) => u.client_id === clientId);
  // Environment precedence (QA-1-15): most recent upgrade row for the server, else bams_objects.environment.
  const env = new Map<string, string>();
  const latest = new Map<string, Row>();
  for (const u of ups) {
    const k = norm(u.server_name);
    const prev = latest.get(k);
    const key = `${u.schedule_year ?? 0}${u.schedule_quarter ?? ''}${u.scheduled_date ?? ''}`;
    const pkey = prev ? `${prev.schedule_year ?? 0}${prev.schedule_quarter ?? ''}${prev.scheduled_date ?? ''}` : '';
    if (!prev || key > pkey) latest.set(k, u);
  }
  for (const [k, u] of latest) env.set(k, u.environment);
  for (const o of objs) if (!env.has(norm(o.name)) && o.environment) env.set(norm(o.name), o.environment);
  const counts = new Map<string, number>();
  for (const e of env.values()) counts.set(e, (counts.get(e) ?? 0) + 1);
  const order = ['PROD', 'DEV'];
  const keys = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.localeCompare(b);
  });
  const next = ups
    .filter((u) => u.scheduled_date != null && u.scheduled_date >= today && u.status !== 'Completed' && u.status !== 'Deferred')
    .sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : 1))[0];
  const servers = new Set<string>([...objs.map((o) => norm(o.name)), ...ups.map((u) => norm(u.server_name))]);
  return {
    servers: servers.size,
    active_alerts: activeAlertCount(t, clientId),
    next_upgrade: next ? { date: next.scheduled_date, server: next.server_name } : null,
    env_summary: keys.map((k) => `${k} ${counts.get(k)}`).join(' · '),
    regions: [...new Set(objs.map((o) => o.region).filter(Boolean) as string[])].sort(),
  };
}

export function infrastructure(t: Tables, clientId: string, today: string, clock: Date): Infrastructure {
  const objs = t.bams_objects.filter((o) => o.client_id === clientId);
  const bams: BamsObject[] = objs
    .map((o) => {
      const metrics = t.bams_metrics.filter((m) => m.object_id === o.id);
      const mIds = new Set(metrics.map((m) => m.id));
      const alerts = t.bams_alert_events.filter(
        (e) => mIds.has(e.metric_id) && (e.status === 'open' || e.status === 'recovered'),
      ).length;
      return {
        id: o.id,
        client_id: o.client_id,
        name: o.name,
        region: o.region ?? null,
        location: o.location ?? null,
        environment: o.environment ?? null,
        enabled: !!o.enabled,
        worst_status: worstStatus(metrics.map((m) => freshnessOf(m, o, clock))),
        metric_count: metrics.length,
        active_alerts: alerts,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const upgrades = t.server_upgrades
    .filter((u) => u.client_id === clientId)
    .map(toUpgrade)
    .sort((a, b) => (b.scheduled_date ?? '').localeCompare(a.scheduled_date ?? '') || a.server_name.localeCompare(b.server_name));
  return { client_id: clientId, bams_objects: bams, upgrades, summary: infrastructureSummary(t, clientId, today) };
}

// ------------------------------------------------------------------ sentences

function parse(json: string | null | undefined): Row {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Display sentence for an audit row (docs/03_DATA_MODEL.md §7 "Activity mapping"). */
export function auditSentence(a: Row, today: string): string {
  const label = a.object_label ?? '';
  const o = parse(a.old_value);
  const n = parse(a.new_value);
  switch (a.object_type) {
    case 'task':
      return `Task ${a.action}: ${label}`;
    case 'contact':
      if (a.action === 'created') return `Contact added: ${label}`;
      if (a.action === 'updated') return `Contact updated: ${label}`;
      if (a.action === 'deleted') return `Contact removed: ${label}`;
      if (a.action === 'primary_changed')
        return o.primary_contact ? `${label} is now primary (was ${o.primary_contact})` : `${label} is now primary`;
      break;
    case 'note':
      if (a.action === 'deleted') return `${o.note_type ?? 'Note'} deleted: ${label}`;
      break;
    case 'client':
      if (a.action === 'next_contact_changed')
        return n.next_contact ? `Next client touch set to ${formatDate(n.next_contact, today)}` : 'Next client touch cleared';
      if (a.action === 'status_changed') return `Account marked ${n.status ?? 'updated'}`;
      break;
    case 'server_upgrade':
      if (a.action === 'created') return `Server upgrade scheduled: ${label}`;
      if (a.action === 'deleted') return `Server upgrade deleted: ${label}`;
      return n.status ? `Server upgrade ${n.status}: ${label}` : `Server upgrade updated: ${label}`;
  }
  return `${a.object_type} ${a.action}: ${label}`;
}

export function bamsSentence(what: string, subject: string, severity: string): string {
  return `BAMS alert ${what}: ${subject} (${severity})`;
}

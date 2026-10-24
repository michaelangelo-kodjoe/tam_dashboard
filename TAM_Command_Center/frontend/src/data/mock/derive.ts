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
  ServerSpark,
  ServerTile,
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
  body_format: r.body_format === 'html' ? 'html' : 'plain',
  body_text: r.body_text ?? r.body ?? null,
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

/** Environment per server (QA-1-15): most recent upgrade row for the server, else bams_objects.environment. */
export function serverEnvironments(t: Tables, clientId: string): Map<string, string> {
  const objs = t.bams_objects.filter((o) => o.client_id === clientId);
  const ups = t.server_upgrades.filter((u) => u.client_id === clientId);
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
  return env;
}

export function infrastructureSummary(t: Tables, clientId: string, today: string): InfrastructureSummary {
  const objs = t.bams_objects.filter((o) => o.client_id === clientId);
  const ups = t.server_upgrades.filter((u) => u.client_id === clientId);
  const env = serverEnvironments(t, clientId);
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

// ------------------------------------------------------------------ server tiles (PM-AC-3, §10.4 #6 and #7)

const SEV_RANK: Record<string, number> = { Critical: 0, Warning: 1, Info: 2 };
export const SPARK_MAX_POINTS = 28;
export const SPARK_WINDOW_HOURS = 168;

/** Contract §9.3: more than `max` samples -> `max` equal-time buckets over first..last, each non-empty bucket keeps its maximum sample. */
export function downsampleMax(points: [string, number][], max = SPARK_MAX_POINTS): [string, number][] {
  if (points.length <= max) return points;
  const t0 = Date.parse(points[0][0]);
  const span = Date.parse(points[points.length - 1][0]) - t0;
  const best = new Map<number, [string, number]>();
  for (const p of points) {
    const idx = span === 0 ? 0 : Math.min(max - 1, Math.floor(((Date.parse(p[0]) - t0) / span) * max));
    const cur = best.get(idx);
    if (!cur || p[1] > cur[1]) best.set(idx, p);
  }
  return [...best.entries()].sort((x, y) => x[0] - y[0]).map(([, p]) => p);
}

export function serverTiles(t: Tables, clientId: string, clock: Date): ServerTile[] {
  const objs = t.bams_objects.filter((o) => o.client_id === clientId);
  const ups = t.server_upgrades.filter((u) => u.client_id === clientId);
  const env = serverEnvironments(t, clientId);
  const names = new Map<string, string>(); // normalized -> display
  for (const u of ups) if (!names.has(norm(u.server_name))) names.set(norm(u.server_name), u.server_name);
  for (const o of objs) names.set(norm(o.name), o.name); // the appliance name wins
  const metricsByObj = new Map<string, Row[]>();
  for (const m of t.bams_metrics) {
    const list = metricsByObj.get(m.object_id) ?? [];
    list.push(m);
    metricsByObj.set(m.object_id, list);
  }
  const winStart = clock.getTime() - SPARK_WINDOW_HOURS * 3_600_000;
  const tiles: ServerTile[] = [];
  for (const [key, display] of names) {
    // version (earliest open upgrade's current_version, else latest Completed upgrade's target_version)
    const mine = ups.filter((u) => norm(u.server_name) === key);
    const open = mine
      .filter((u) => u.status !== 'Completed' && u.status !== 'Deferred')
      .sort((a, b) => (a.scheduled_date ?? '9999') .localeCompare(b.scheduled_date ?? '9999') || String(a.id).localeCompare(String(b.id)))[0];
    const done = mine
      .filter((u) => u.status === 'Completed')
      .sort((a, b) => (b.scheduled_date ?? '').localeCompare(a.scheduled_date ?? '') || String(a.id).localeCompare(String(b.id)))[0];
    const version = open ? (open.current_version ?? null) : done ? (done.target_version ?? null) : null;

    // worst open alert and its metric
    const myObjs = objs.filter((o) => norm(o.name) === key);
    const myMetrics = myObjs.filter((o) => o.enabled).flatMap((o) => (metricsByObj.get(o.id) ?? []).filter((m) => m.enabled));
    const mIds = new Map<string, Row>(myMetrics.map((m) => [m.id, m]));
    const openAlerts = t.bams_alert_events
      .filter((e) => e.status === 'open' && mIds.has(e.metric_id))
      .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || (a.opened_at < b.opened_at ? -1 : a.opened_at > b.opened_at ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
    const worst = openAlerts[0];
    const metric = worst
      ? mIds.get(worst.metric_id)!
      : myMetrics.filter((m) => /cpu/i.test(m.metric_name)).sort((a, b) => String(a.metric_name).localeCompare(String(b.metric_name)))[0];

    let spark: ServerSpark | null = null;
    if (metric) {
      const pts: [string, number][] = t.bams_metric_samples
        .filter((s) => s.metric_id === metric.id && Date.parse(s.sampled_at) >= winStart && Date.parse(s.sampled_at) <= clock.getTime())
        .sort((a, b) => (a.sampled_at < b.sampled_at ? -1 : 1))
        .map((s) => [s.sampled_at as string, s.value as number]);
      if (pts.length > 0) {
        const spanH = (clock.getTime() - Date.parse(pts[0][0])) / 3_600_000; // first sample to now (contract §9.3)
        spark = {
          metric: metric.metric_name,
          window_hours: Math.min(SPARK_WINDOW_HOURS, Math.max(1, Math.ceil(spanH))),
          points: downsampleMax(pts),
        };
      }
    }
    tiles.push({
      name: display,
      environment: env.get(key) ?? null,
      version,
      alert_severity: (worst?.severity as ServerTile['alert_severity']) ?? null,
      spark,
    });
  }
  return tiles.sort((a, b) => a.name.localeCompare(b.name));
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
  return { client_id: clientId, bams_objects: bams, upgrades, summary: infrastructureSummary(t, clientId, today), servers: serverTiles(t, clientId, clock) };
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

// Mock BAMS engine (docs/04_API_CONTRACT.md §11). It reads and writes the same rebased tables as the
// rest of MockDataSource and mirrors the backend rules the UI depends on: freshness bands, alert
// precedence, filters/sort, delete blocking, ticker uniqueness and rule validation. The monitor does
// not poll in mock mode (the frozen BAMS mock clock is the "latest poll"); values never change.
// `?mockProvider=unavailable` simulates the PROD stub: every value is No Data and nothing is shown.
import type {
  AlertListStatus, AlertStatus, BamsAlertEvent, BamsAlertItem, BamsAlertList, BamsConfig, BamsConfigApplied, BamsConfigPreview, BamsDeletePreview, BamsDeleteResult,
  BamsFreshness, BamsMetricDetail, BamsMetricInput, BamsMonitor, BamsNotifications, BamsObjectInput, BamsObjectSaved, BamsProvider, BamsRow, BamsRule, BamsRuleInput,
  BamsSettings, BamsState, BamsStateQuery, BamsSummary, BamsTrend, BamsView, DisplayStatus, Severity, TrendRange,
} from '../../bamsTypes';
import { DataSourceError } from '../DataSource';
import { breaches, formatPlain, globMatch, rulePreview, ruleCondition, ruleLevel, SEVERITY_ORDER } from '../../lib/bams';
import type { Row, Tables } from './rebase';

const DAY = 86_400_000;
export interface BamsCtx {
  t: Tables;
  clock: Date;
  unavailable: boolean;
  now: () => string;
  uuid: () => string;
  audit: (a: { client_id: string | null; object_type: string; object_id: string; object_label: string; action: string; old?: Row | null; new?: Row | null; reason?: string | null }) => void;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const fail = (code: ConstructorParameters<typeof DataSourceError>[0], message: string, fields?: Record<string, string>, details?: Record<string, unknown>) =>
  new DataSourceError(code, message, fields, code === 'not_found' ? 404 : code === 'validation_error' ? 422 : 409, details);

export class MockBams {
  desiredRunning = true;
  settings: BamsSettings = { poll_interval_seconds: 60, in_app_notifications: true, desktop_notifications: true, notify_recovered: false, privacy_mode: true };
  private readThrough: number;
  private extraNotifs: Row[] = [];

  constructor(private c: BamsCtx) {
    const ids = c.t.bams_notification_log.filter((n) => n.channel === 'in_app').map((n) => n.id as number);
    const sorted = [...ids].sort((a, b) => a - b);
    this.readThrough = sorted.length > 3 ? sorted[sorted.length - 4] : 0;
  }

  private get t() { return this.c.t; }
  private get liveSeconds() { return Math.max(this.settings.poll_interval_seconds + 15, 75); }

  provider(): BamsProvider {
    return this.c.unavailable
      ? { mode: 'PROD', kind: 'blpapi', available: false, simulated: false, message: 'BLPAPI provider not implemented/connected' }
      : { mode: 'DEV', kind: 'simulated', available: true, simulated: true, message: null };
  }
  monitor(): BamsMonitor {
    const running = this.desiredRunning && !this.c.unavailable;
    const last = new Date(this.c.clock.getTime() - 8000);
    return {
      state: this.c.unavailable ? 'provider_unavailable' : this.desiredRunning ? 'running' : 'stopped',
      desired_running: this.desiredRunning,
      poll_interval_seconds: this.settings.poll_interval_seconds,
      started_at: running ? new Date(this.c.clock.getTime() - 6 * 3600_000).toISOString() : null,
      last_poll_at: this.c.unavailable ? null : last.toISOString(),
      next_poll_at: running ? new Date(last.getTime() + this.settings.poll_interval_seconds * 1000).toISOString() : null,
      last_poll_ok: this.c.unavailable ? null : true,
      last_error: null,
      freshness: { live_seconds: this.liveSeconds, stale_seconds_default: 120 },
    };
  }

  // ---------------------------------------------------------------- rows
  private freshnessOf(m: Row): { f: BamsFreshness; age: number | null } {
    if (this.c.unavailable || m.last_received == null) return { f: 'No Data', age: m.last_received == null ? null : Math.round((this.c.clock.getTime() - Date.parse(m.last_received)) / 1000) };
    const age = Math.round((this.c.clock.getTime() - Date.parse(m.last_received)) / 1000);
    return { f: age <= this.liveSeconds ? 'Live' : age <= (m.stale_after_seconds ?? 120) ? 'Delayed' : 'Stale', age };
  }

  private sparkOf(m: Row): number[] {
    const from = this.c.clock.getTime() - DAY;
    const pts = this.t.bams_metric_samples.filter((s) => s.metric_id === m.id && Date.parse(s.sampled_at) >= from && Date.parse(s.sampled_at) <= this.c.clock.getTime())
      .sort((a, b) => a.sampled_at.localeCompare(b.sampled_at)).map((s) => s.value as number);
    if (pts.length <= 24) return pts;
    const out: number[] = [];
    for (let i = 0; i < 24; i++) out.push(pts[Math.floor((i * (pts.length - 1)) / 23)]);
    return out;
  }

  private activeEvents(metricId: string): Row[] {
    return this.t.bams_alert_events.filter((e) => e.metric_id === metricId && (e.status === 'open' || e.status === 'recovered'));
  }

  row(m: Row, withSpark: boolean): BamsRow {
    const o = this.t.bams_objects.find((x) => x.id === m.object_id)!;
    const cl = this.t.clients.find((x) => x.id === o.client_id);
    const { f, age } = this.freshnessOf(m);
    const act = this.activeEvents(m.id).sort((a, b) => SEVERITY_ORDER[a.severity as Severity] - SEVERITY_ORDER[b.severity as Severity] || a.opened_at.localeCompare(b.opened_at));
    const top = act[0];
    const unav = this.c.unavailable;
    const enabled = !!m.enabled && !!o.enabled;
    const ds: DisplayStatus = !enabled ? 'disabled'
      : top ? (act.some((e) => e.status === 'open') ? 'open' : 'recovered')
      : f === 'Stale' ? 'stale' : f === 'No Data' ? 'no_data' : f === 'Delayed' ? 'delayed' : 'live';
    const hi = (v: number | null, d: string | null) => ({ value: v ?? null, date: d ?? null });
    return {
      id: m.id, metric_name: m.metric_name, ticker: m.ticker, enabled: !!m.enabled, stale_after_seconds: m.stale_after_seconds ?? 120, row_version: m.row_version,
      object: { id: o.id, name: o.name, client_id: o.client_id, client_name: cl?.name ?? '', region: o.region ?? null, location: o.location ?? null, environment: o.environment ?? null, enabled: !!o.enabled, row_version: o.row_version },
      current_value: unav ? null : m.current_value ?? null,
      last_source_update: unav ? null : m.last_source_update ?? null,
      last_received: unav ? null : m.last_received ?? null,
      age_seconds: unav ? null : age, freshness: f, simulated: !unav,
      highs: { d30: hi(m.high_30, m.high_30_date), d60: hi(m.high_60, m.high_60_date), d90: hi(m.high_90, m.high_90_date) },
      alert: top ? { id: top.id, status: top.status as AlertStatus, severity: top.severity as Severity, opened_at: top.opened_at } : null,
      active_alerts: act.length, display_status: ds,
      ...(withSpark ? { spark: unav ? [] : this.sparkOf(m) } : {}),
    };
  }

  private enabledMetrics(includeDisabled: boolean): Row[] {
    return this.t.bams_metrics.filter((m) => {
      const o = this.t.bams_objects.find((x) => x.id === m.object_id);
      return !!o && (includeDisabled || (!!o.enabled && !!m.enabled));
    });
  }

  getState(q: BamsStateQuery): BamsState {
    const all = this.enabledMetrics(!!q.include_disabled).map((m) => this.row(m, q.spark !== false));
    const accounts = q.account ? new Set(q.account.split(',')) : null;
    const text = q.q?.trim().toLowerCase();
    const pass = (r: BamsRow, view: BamsView | null) => {
      if (accounts && !accounts.has(r.object.client_id)) return false;
      if (q.object_id && r.object.id !== q.object_id) return false;
      if (q.location && (r.object.location ?? '').toLowerCase() !== q.location.toLowerCase()) return false;
      if (q.metric && r.metric_name.toLowerCase() !== q.metric.toLowerCase()) return false;
      if (q.status) {
        const s = q.status;
        const ok = s === 'open' || s === 'recovered' ? r.alert?.status === s : r.freshness === ({ live: 'Live', delayed: 'Delayed', stale: 'Stale', no_data: 'No Data' } as const)[s];
        if (!ok) return false;
      }
      if (text && ![r.object.name, r.object.client_name, r.metric_name, r.ticker].some((x) => x.toLowerCase().includes(text))) return false;
      if (view === 'active_alerts') return r.active_alerts > 0;
      if (view === 'delayed_stale') return r.freshness === 'Delayed' || r.freshness === 'Stale';
      if (view === 'live') return r.freshness === 'Live';
      if (view === 'no_data') return r.freshness === 'No Data';
      return true;
    };
    const rows = all.filter((r) => pass(r, q.view ?? 'all'));
    const rank: Record<DisplayStatus, number> = { open: 0, recovered: 1, stale: 2, no_data: 3, delayed: 4, live: 5, disabled: 6 };
    const key = (r: BamsRow): string | number | null => {
      switch (q.sort ?? 'status') {
        case 'appliance': return `${r.object.client_name} / ${r.object.name}`.toLowerCase();
        case 'location': return (r.object.location ?? '').toLowerCase() || null;
        case 'metric': return r.metric_name.toLowerCase();
        case 'current': return r.current_value;
        case 'high30': return r.highs.d30.value;
        case 'high60': return r.highs.d60.value;
        case 'high90': return r.highs.d90.value;
        case 'last_update': return r.age_seconds;
        default: return rank[r.display_status];
      }
    };
    const dir = q.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const ka = key(a); const kb = key(b);
      if (ka == null && kb != null) return 1;
      if (kb == null && ka != null) return -1;
      if (ka != null && kb != null && ka !== kb) return (ka < kb ? -1 : 1) * dir;
      return `${a.object.client_name}${a.object.name}${a.metric_name}`.localeCompare(`${b.object.client_name}${b.object.name}${b.metric_name}`);
    });
    const enabledAll = this.enabledMetrics(false).map((m) => this.row(m, false));
    const act = this.t.bams_alert_events.filter((e) => (e.status === 'open' || e.status === 'recovered') && enabledAll.some((r) => r.id === e.metric_id));
    const count = (f: BamsFreshness) => enabledAll.filter((r) => r.freshness === f).length;
    const summary: BamsSummary = {
      active_alerts: act.length, open: act.filter((e) => e.status === 'open').length, recovered: act.filter((e) => e.status === 'recovered').length,
      delayed: count('Delayed'), stale: count('Stale'), delayed_stale: count('Delayed') + count('Stale'), live: count('Live'), no_data: count('No Data'), total: enabledAll.length,
    };
    const vc = (v: BamsView) => all.filter((r) => pass(r, v)).length;
    const uniq = <T,>(l: T[], k: (x: T) => string) => [...new Map(l.map((x) => [k(x), x])).values()];
    return {
      server_time: this.c.clock.toISOString(),
      monitor: this.monitor(), provider: this.provider(),
      banner: this.c.unavailable ? { code: 'provider_unavailable', text: 'BLPAPI provider is not connected. No live values are shown.' } : null,
      summary,
      view_counts: { all: vc('all'), active_alerts: vc('active_alerts'), delayed_stale: vc('delayed_stale'), live: vc('live'), no_data: vc('no_data') },
      filters: {
        accounts: uniq(enabledAll.map((r) => ({ id: r.object.client_id, name: r.object.client_name })), (a) => a.id).sort((a, b) => a.name.localeCompare(b.name)),
        locations: [...new Set(enabledAll.map((r) => r.object.location).filter((x): x is string => !!x))].sort(),
        objects: uniq(enabledAll.map((r) => ({ id: r.object.id, name: r.object.name, client_id: r.object.client_id, client_name: r.object.client_name })), (o) => o.id).sort((a, b) => a.name.localeCompare(b.name)),
        metrics: [...new Set(enabledAll.map((r) => r.metric_name))].sort(),
      },
      counts: { rows: rows.length, unfiltered: enabledAll.length },
      rows,
    };
  }

  // ---------------------------------------------------------------- metric detail, trend
  private findMetric(id: string): Row {
    const m = this.t.bams_metrics.find((x) => x.id === id);
    if (!m) throw fail('not_found', 'Metric not found.');
    return m;
  }

  event(e: Row): BamsAlertEvent {
    const m = this.t.bams_metrics.find((x) => x.id === e.metric_id);
    const rule = this.t.bams_alert_rules.find((r) => r.id === e.rule_id);
    const row = m ? this.row(m, false) : null;
    const active = e.status === 'open' || e.status === 'recovered';
    let still = false;
    if (active && row && rule && row.freshness === 'Live' && row.current_value != null) {
      const lvl = ruleLevel(rule as never, row.highs);
      still = lvl != null && breaches(rule.operator, row.current_value, lvl);
    }
    return {
      id: e.id, metric_id: e.metric_id, rule_id: rule ? rule.id : null, alert_type: e.alert_type, severity: e.severity, status: e.status, message: String(e.message).replace(/\s*\(value [^)]*\)\s*$/, ''),
      opened_at: e.opened_at, last_triggered_at: e.last_triggered_at ?? null, recovered_at: e.recovered_at ?? null, closed_at: e.closed_at ?? null,
      trigger_value: e.trigger_value ?? null, current_value: row ? row.current_value : e.current_value ?? null, peak_value: e.peak_value ?? null, closed_note: e.closed_note ?? null,
      still_breaching: still, rule_summary: rule ? `${ruleCondition(rule as never)} for ${rule.consecutive_updates} ${rule.consecutive_updates === 1 ? 'update' : 'updates'}` : null, row_version: e.row_version,
    };
  }

  private rule(r: Row): BamsRule {
    const m = this.findMetric(r.metric_id);
    const row = this.row(m, false);
    return {
      id: r.id, metric_id: r.metric_id, rule_type: r.rule_type, operator: r.operator, threshold: r.threshold ?? null, reference_period: r.reference_period ?? null,
      consecutive_updates: r.consecutive_updates, severity: r.severity, cooldown_minutes: r.cooldown_minutes, enabled: !!r.enabled, suppress_until_clear: !!r.suppress_until_clear,
      breach_count: r.breach_count ?? 0, preview: rulePreview(m.metric_name, r as never, row.highs), row_version: r.row_version, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  getMetric(id: string): BamsMetricDetail {
    const m = this.findMetric(id);
    const evs = this.t.bams_alert_events.filter((e) => e.metric_id === id).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    return {
      row: this.row(m, true),
      rules: this.t.bams_alert_rules.filter((r) => r.metric_id === id).map((r) => this.rule(r)),
      alerts: evs.slice(0, 50).map((e) => this.event(e)), alerts_total: evs.length, ranges: ['24h', '7d', '30d', '90d'],
    };
  }

  getTrend(id: string, range: TrendRange): BamsTrend {
    const m = this.findMetric(id);
    const row = this.row(m, false);
    const to = this.c.clock.getTime();
    const from = to - ({ '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[range]) * DAY;
    const raw = this.c.unavailable ? [] : this.t.bams_metric_samples.filter((s) => s.metric_id === id && Date.parse(s.sampled_at) >= from && Date.parse(s.sampled_at) <= to).sort((a, b) => a.sampled_at.localeCompare(b.sampled_at));
    const vals = raw.map((s) => s.value as number);
    let points = raw.map((s) => ({ t: s.sampled_at as string, v: s.value as number }));
    const downsampled = points.length > 500;
    if (downsampled) {
      const size = points.length / 500;
      points = Array.from({ length: 500 }, (_, i) => {
        const part = raw.slice(Math.floor(i * size), Math.floor((i + 1) * size) || undefined);
        return { t: part[0].sampled_at as string, v: part.reduce((a, s) => a + (s.value as number), 0) / part.length };
      });
    }
    const hl = (id: string, label: string, h: { value: number | null; date: string | null }) => ({ id, label, value: h.value, date: h.date });
    return {
      metric_id: id, range, from: new Date(from).toISOString(), to: new Date(to).toISOString(), points, downsampled,
      text: { min: vals.length ? Math.min(...vals) : null, max: vals.length ? Math.max(...vals) : null, last: vals.length ? vals[vals.length - 1] : null, count: vals.length, from: raw[0]?.sampled_at ?? null, to: raw[raw.length - 1]?.sampled_at ?? null },
      reference_lines: [hl('high_30', '30D high', row.highs.d30), hl('high_60', '60D high', row.highs.d60), hl('high_90', '90D high', row.highs.d90)],
      rule_lines: this.t.bams_alert_rules.filter((r) => r.metric_id === id && r.enabled).flatMap((r) => {
        const lvl = ruleLevel(r as never, row.highs);
        return lvl == null ? [] : [{ rule_id: r.id as string, label: `${r.severity} threshold ${formatPlain(Math.round(lvl * 10) / 10)}`, value: lvl, severity: r.severity as Severity }];
      }),
    };
  }

  // ---------------------------------------------------------------- alerts
  getAlerts(q: { status?: AlertListStatus; account?: string; metric_id?: string; limit?: number }): BamsAlertList {
    const status = q.status ?? 'active';
    const accounts = q.account ? new Set(q.account.split(',')) : null;
    const enabledIds = new Set(this.enabledMetrics(false).map((m) => m.id));
    const items: BamsAlertItem[] = this.t.bams_alert_events
      .filter((e) => !q.metric_id || e.metric_id === q.metric_id)
      .map((e) => ({ e, m: this.t.bams_metrics.find((x) => x.id === e.metric_id) }))
      .filter((x): x is { e: Row; m: Row } => !!x.m)
      .map(({ e, m }) => {
        const o = this.t.bams_objects.find((x) => x.id === m.object_id)!;
        const cl = this.t.clients.find((x) => x.id === o.client_id);
        return { e, m, o, cl };
      })
      .filter(({ o }) => !accounts || accounts.has(o.client_id))
      .map(({ e, m, o, cl }) => ({
        event: this.event(e),
        metric: { id: m.id, metric_name: m.metric_name, ticker: m.ticker },
        object: { id: o.id, name: o.name, client_id: o.client_id, client_name: cl?.name ?? '', location: o.location ?? null },
        freshness: this.freshnessOf(m).f,
      }));
    const act = (i: BamsAlertItem) => i.event.status !== 'closed';
    const visibleActive = items.filter((i) => act(i) && enabledIds.has(i.metric.id));
    const closed = items.filter((i) => !act(i));
    const sevOrder = (a: BamsAlertItem, b: BamsAlertItem) =>
      (a.event.status === b.event.status ? 0 : a.event.status === 'open' ? -1 : 1) || SEVERITY_ORDER[a.event.severity] - SEVERITY_ORDER[b.event.severity] || a.event.opened_at.localeCompare(b.event.opened_at);
    visibleActive.sort(sevOrder);
    closed.sort((a, b) => (b.event.closed_at ?? b.event.opened_at).localeCompare(a.event.closed_at ?? a.event.opened_at));
    const pick = status === 'active' ? visibleActive : status === 'open' ? visibleActive.filter((i) => i.event.status === 'open') : status === 'recovered' ? visibleActive.filter((i) => i.event.status === 'recovered')
      : status === 'closed' ? closed : [...visibleActive, ...closed];
    return {
      counts: { active: visibleActive.length, open: visibleActive.filter((i) => i.event.status === 'open').length, recovered: visibleActive.filter((i) => i.event.status === 'recovered').length, closed: closed.length },
      items: pick.slice(0, q.limit ?? 100), next_before: null,
    };
  }

  closeAlert(id: string, note: string | null): { event: BamsAlertEvent; suppressed_until_clear: boolean } {
    const e = this.t.bams_alert_events.find((x) => x.id === id);
    if (!e) throw fail('not_found', 'Alert not found.');
    if (e.status === 'closed') throw fail('conflict', 'This alert is already closed.', undefined, { reason: 'already_closed' });
    if (note && note.length > 2000) throw fail('validation_error', 'Note must be 2000 characters or fewer.', { note: 'Note must be 2000 characters or fewer.' });
    const still = this.event(e).still_breaching;
    const m = this.findMetric(e.metric_id);
    const o = this.t.bams_objects.find((x) => x.id === m.object_id)!;
    e.status = 'closed'; e.closed_at = this.c.now(); e.closed_note = note?.trim() || null; e.row_version += 1; e.updated_at = e.closed_at;
    const rule = this.t.bams_alert_rules.find((r) => r.id === e.rule_id);
    if (rule && still) { rule.suppress_until_clear = 1; rule.row_version += 1; }
    this.c.audit({ client_id: o.client_id, object_type: 'bams_alert_event', object_id: e.id, object_label: `${o.name} · ${m.metric_name}`, action: 'closed', reason: e.closed_note });
    this.extraNotifs.push({ id: Math.max(0, ...this.t.bams_notification_log.map((n) => n.id as number), ...this.extraNotifs.map((n) => n.id as number)) + 1, event_id: e.id, kind: 'closed', channel: 'in_app', attempted_at: e.closed_at, success: 1 });
    return { event: this.event(e), suppressed_until_clear: still };
  }

  // ---------------------------------------------------------------- notifications
  getNotifications(limit = 30): BamsNotifications {
    const rows = [...this.t.bams_notification_log, ...this.extraNotifs].filter((n) => n.channel === 'in_app').sort((a, b) => b.attempted_at.localeCompare(a.attempted_at));
    const items = rows.flatMap((n) => {
      const e = this.t.bams_alert_events.find((x) => x.id === n.event_id);
      const m = e && this.t.bams_metrics.find((x) => x.id === e.metric_id);
      const o = m && this.t.bams_objects.find((x) => x.id === m.object_id);
      if (!e || !m || !o) return [];
      const cl = this.t.clients.find((x) => x.id === o.client_id);
      const kind = n.kind as 'opened' | 'recovered' | 'closed';
      const title = kind === 'opened' ? `${e.severity} opened: ${m.metric_name}` : kind === 'recovered' ? `Recovered: ${m.metric_name}` : `Closed: ${m.metric_name}`;
      const detail = `${cl?.name ?? ''} / ${o.name} · ${kind === 'opened' ? `value ${e.trigger_value ?? e.peak_value}%` : kind === 'recovered' ? 'awaiting close' : 'by you'}`;
      return [{ id: n.id as number, event_id: e.id as string, kind, attempted_at: n.attempted_at as string, title, detail, severity: e.severity as Severity, unread: (n.id as number) > this.readThrough, status: e.status as AlertStatus }];
    });
    return { unread_count: items.filter((i) => i.unread).length, items: items.slice(0, limit) };
  }
  markRead(input: { through_id: number } | { all: true }): number {
    const ids = [...this.t.bams_notification_log, ...this.extraNotifs].map((n) => n.id as number);
    this.readThrough = 'all' in input ? Math.max(0, ...ids) : Math.max(this.readThrough, input.through_id);
    return this.getNotifications(200).unread_count;
  }

  // ---------------------------------------------------------------- settings, monitor
  saveSettings(patch: Partial<BamsSettings>): BamsSettings {
    const p = patch.poll_interval_seconds;
    if (p !== undefined && (!Number.isInteger(p) || p < 30 || p > 86_400)) throw fail('validation_error', 'Poll interval must be 30 to 86400 seconds.', { poll_interval_seconds: 'Poll interval must be 30 seconds or more.' });
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  // ---------------------------------------------------------------- objects and metrics
  private tickerOwner(ticker: string, exceptMetric?: string): Row | undefined {
    return this.t.bams_metrics.find((m) => m.id !== exceptMetric && norm(m.ticker) === norm(ticker));
  }

  saveObject(input: BamsObjectInput): BamsObjectSaved {
    const fields: Record<string, string> = {};
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (!name) fields.name = 'Appliance name is required.';
    else if (name.length > 200) fields.name = 'Appliance name must be 200 characters or fewer.';
    const existing = input.id ? this.t.bams_objects.find((o) => o.id === input.id) : undefined;
    if (input.id && !existing) throw fail('not_found', 'Appliance not found.');
    const clientId = existing ? existing.client_id : input.client_id;
    if (!existing && (!clientId || !this.t.clients.some((c) => c.id === clientId))) fields.client_id = 'Choose an account.';
    if (!existing && input.metrics.length === 0) fields.metrics = 'Add at least one metric.';
    input.metrics.forEach((m, i) => {
      if (!m.metric_name.trim()) fields[`metrics[${i}].metric_name`] = 'Metric name is required.';
      if (!m.ticker.trim()) fields[`metrics[${i}].ticker`] = 'Ticker is required.';
    });
    if (Object.keys(fields).length) throw fail('validation_error', 'Check the highlighted fields.', fields);
    if (existing && input.expected_row_version != null && input.expected_row_version !== existing.row_version) throw fail('stale_write', 'This appliance changed since you opened it. Reload and try again.');
    const dup = this.t.bams_objects.find((o) => o.client_id === clientId && o.id !== existing?.id && norm(o.name) === norm(name));
    if (dup) throw fail('conflict', `An appliance named ${name} already exists for this account.`, { name: `An appliance named ${name} already exists for this account.` });
    const seen = new Map<string, number>();
    const names = new Set(existing ? this.t.bams_metrics.filter((m) => m.object_id === existing.id && !input.metrics.some((x) => x.id === m.id)).map((m) => norm(m.metric_name)) : []);
    for (let i = 0; i < input.metrics.length; i++) {
      const m = input.metrics[i];
      const tk = norm(m.ticker);
      if (seen.has(tk)) throw fail('conflict', `Ticker ${m.ticker.trim()} is repeated in this request.`, { [`metrics[${i}].ticker`]: `Ticker ${m.ticker.trim()} is repeated in this request.` });
      seen.set(tk, i);
      const owner = this.tickerOwner(m.ticker, m.id);
      if (owner) {
        const oo = this.t.bams_objects.find((o) => o.id === owner.object_id);
        throw fail('conflict', `Ticker ${m.ticker.trim()} is already used.`, { [`metrics[${i}].ticker`]: `Ticker ${m.ticker.trim()} is already used by ${owner.metric_name} on ${oo?.name ?? 'another appliance'}.` }, { owner: { metric_id: owner.id, metric_name: owner.metric_name, object_name: oo?.name } });
      }
      const mn = norm(m.metric_name);
      if (names.has(mn)) throw fail('conflict', `Metric ${m.metric_name.trim()} is repeated on this appliance.`, { [`metrics[${i}].metric_name`]: `Metric ${m.metric_name.trim()} is repeated on this appliance.` });
      names.add(mn);
    }
    const ts = this.c.now();
    let o: Row;
    if (existing) {
      const before = { name: existing.name, region: existing.region, location: existing.location, environment: existing.environment, enabled: existing.enabled };
      Object.assign(existing, { name, region: input.region === undefined ? existing.region : input.region?.trim() || null, location: input.location === undefined ? existing.location : input.location?.trim() || null, environment: input.environment === undefined ? existing.environment : input.environment ?? null, enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0, updated_at: ts });
      existing.row_version += 1; o = existing;
      this.c.audit({ client_id: existing.client_id, object_type: 'bams_object', object_id: existing.id, object_label: name, action: 'updated', old: before, new: { name, region: existing.region, location: existing.location, environment: existing.environment, enabled: existing.enabled } });
    } else {
      o = { id: this.c.uuid(), client_id: clientId, name, region: input.region?.trim() || null, location: input.location?.trim() || null, environment: input.environment ?? null, enabled: input.enabled ? 1 : 0, created_at: ts, updated_at: ts, row_version: 1 };
      this.t.bams_objects.push(o);
      this.c.audit({ client_id: clientId!, object_type: 'bams_object', object_id: o.id, object_label: name, action: 'created', new: { name, metrics: input.metrics.length } });
    }
    for (const m of input.metrics) {
      const cur = m.id ? this.t.bams_metrics.find((x) => x.id === m.id && x.object_id === o.id) : undefined;
      if (cur) {
        if (norm(cur.ticker) !== norm(m.ticker)) { cur.ticker = m.ticker.trim(); cur.current_value = null; cur.last_source_update = null; cur.last_received = null; }
        Object.assign(cur, { metric_name: m.metric_name.trim(), enabled: m.enabled === false ? 0 : 1, stale_after_seconds: m.stale_after_seconds ?? cur.stale_after_seconds, updated_at: ts });
        cur.row_version += 1;
      } else {
        this.t.bams_metrics.push({
          id: this.c.uuid(), object_id: o.id, metric_name: m.metric_name.trim(), ticker: m.ticker.trim(), current_value: null, last_source_update: null, last_received: null,
          high_30: null, high_30_date: null, high_60: null, high_60_date: null, high_90: null, high_90_date: null, enabled: m.enabled === false ? 0 : 1,
          stale_suppressed: 0, stale_after_seconds: m.stale_after_seconds ?? 120, created_at: ts, updated_at: ts, row_version: 1,
        });
      }
    }
    return {
      id: o.id, client_id: o.client_id, name: o.name, region: o.region, location: o.location, environment: o.environment, enabled: !!o.enabled, row_version: o.row_version,
      metrics: this.t.bams_metrics.filter((m) => m.object_id === o.id).map((m) => ({ id: m.id, metric_name: m.metric_name, ticker: m.ticker, enabled: !!m.enabled, stale_after_seconds: m.stale_after_seconds, row_version: m.row_version })),
    };
  }

  saveMetric(input: BamsMetricInput & { object_id?: string }): void {
    if (input.id) {
      const cur = this.findMetric(input.id);
      this.saveObject({ id: cur.object_id, name: this.t.bams_objects.find((o) => o.id === cur.object_id)!.name, region: null, location: null, environment: null, enabled: true, metrics: [input] });
    }
  }

  private metricIdsOf(kind: 'object' | 'metric', id: string): string[] {
    if (kind === 'metric') { this.findMetric(id); return [id]; }
    if (!this.t.bams_objects.some((o) => o.id === id)) throw fail('not_found', 'Appliance not found.');
    return this.t.bams_metrics.filter((m) => m.object_id === id).map((m) => m.id);
  }
  deletePreview(kind: 'object' | 'metric', id: string): BamsDeletePreview {
    const ids = new Set(this.metricIdsOf(kind, id));
    const evs = this.t.bams_alert_events.filter((e) => ids.has(e.metric_id));
    const active = evs.filter((e) => e.status !== 'closed').length;
    const name = kind === 'object' ? this.t.bams_objects.find((o) => o.id === id)!.name : this.findMetric(id).metric_name;
    return {
      name, metrics: ids.size, samples: this.t.bams_metric_samples.filter((s) => ids.has(s.metric_id)).length * 24, rules: this.t.bams_alert_rules.filter((r) => ids.has(r.metric_id)).length,
      alerts_total: evs.length, alerts_active: active, blocked: active > 0,
      blocked_reason: active ? `${active} ${active === 1 ? 'alert is' : 'alerts are'} still open or recovered. Close ${active === 1 ? 'it' : 'them'} first.` : null,
    };
  }
  deleteItem(kind: 'object' | 'metric', id: string): BamsDeleteResult {
    const p = this.deletePreview(kind, id);
    if (p.blocked) throw fail('conflict', p.blocked_reason ?? 'Blocked by an active alert.', undefined, { reason: 'active_alert' });
    const ids = new Set(this.metricIdsOf(kind, id));
    const obj = kind === 'object' ? this.t.bams_objects.find((o) => o.id === id)! : this.t.bams_objects.find((o) => o.id === this.findMetric(id).object_id)!;
    for (const k of ['bams_alert_events', 'bams_alert_rules', 'bams_metric_samples'] as const) this.t[k] = this.t[k].filter((r) => !ids.has(r.metric_id));
    this.t.bams_metrics = this.t.bams_metrics.filter((m) => !ids.has(m.id));
    if (kind === 'object') this.t.bams_objects = this.t.bams_objects.filter((o) => o.id !== id);
    this.c.audit({ client_id: obj.client_id, object_type: kind === 'object' ? 'bams_object' : 'bams_metric', object_id: id, object_label: p.name, action: 'deleted' });
    return { id, name: p.name, metrics: p.metrics, samples: p.samples, rules: p.rules, alerts: p.alerts_total };
  }

  // ---------------------------------------------------------------- rules and templates
  saveRule(input: BamsRuleInput): BamsRule {
    const cur = input.id ? this.t.bams_alert_rules.find((r) => r.id === input.id) : undefined;
    if (input.id && !cur) throw fail('not_found', 'Rule not found.');
    const metricId = cur ? cur.metric_id : input.metric_id!;
    this.findMetric(metricId);
    const f: Record<string, string> = {};
    const op = input.operator ?? '>';
    if (input.rule_type === 'fixed_threshold') {
      if (input.threshold == null) f.threshold = 'Threshold is required for a threshold rule.';
      if (input.reference_period != null) f.reference_period = 'Reference period must be empty for a threshold rule.';
    } else if (input.rule_type === 'pct_of_high') {
      if (input.threshold == null || input.threshold <= 0) f.threshold = 'Percent of high needs a threshold above 0.';
      if (!input.reference_period) f.reference_period = 'Choose the period of the high.';
    } else {
      if (!input.reference_period) f.reference_period = 'Choose the period of the high.';
      if (input.threshold != null) f.threshold = 'Historical high takes no threshold.';
      if (op !== '>' && op !== '>=') f.operator = 'Historical high needs > or >=.';
    }
    if (!Number.isInteger(input.consecutive_updates) || input.consecutive_updates < 1) f.consecutive_updates = 'Consecutive updates must be 1 or more.';
    if (!Number.isInteger(input.cooldown_minutes) || input.cooldown_minutes < 0 || input.cooldown_minutes > 10_080) f.cooldown_minutes = 'Cooldown must be 0 to 10080 minutes.';
    if (Object.keys(f).length) throw fail('validation_error', 'Check the highlighted fields.', f);
    if (cur && input.expected_row_version != null && input.expected_row_version !== cur.row_version) throw fail('stale_write', 'This rule changed since you opened it.');
    const ts = this.c.now();
    const body = {
      rule_type: input.rule_type, operator: op, threshold: input.threshold, reference_period: input.reference_period, consecutive_updates: input.consecutive_updates,
      severity: input.severity, cooldown_minutes: input.cooldown_minutes, enabled: input.enabled ? 1 : 0, suppress_until_clear: input.suppress_until_clear ? 1 : 0,
    };
    const m = this.findMetric(metricId);
    const o = this.t.bams_objects.find((x) => x.id === m.object_id)!;
    let r: Row;
    if (cur) {
      Object.assign(cur, body, { breach_count: 0, updated_at: ts }); cur.row_version += 1; r = cur;
      this.c.audit({ client_id: o.client_id, object_type: 'bams_rule', object_id: r.id, object_label: `${o.name} · ${m.metric_name}`, action: 'updated', new: body });
    } else {
      r = { id: this.c.uuid(), metric_id: metricId, ...body, breach_count: 0, created_at: ts, updated_at: ts, row_version: 1 };
      this.t.bams_alert_rules.push(r);
      this.c.audit({ client_id: o.client_id, object_type: 'bams_rule', object_id: r.id, object_label: `${o.name} · ${m.metric_name}`, action: 'created', new: body });
    }
    return this.rule(r);
  }
  deleteRule(id: string): void {
    const r = this.t.bams_alert_rules.find((x) => x.id === id);
    if (!r) throw fail('not_found', 'Rule not found.');
    if (this.t.bams_alert_events.some((e) => e.rule_id === id && e.status !== 'closed')) throw fail('conflict', 'This rule has an open or recovered alert. Close the alert first.', undefined, { reason: 'active_alert' });
    for (const e of this.t.bams_alert_events) if (e.rule_id === id) e.rule_id = null;
    this.t.bams_alert_rules = this.t.bams_alert_rules.filter((x) => x.id !== id);
  }

  getConfigs(): BamsConfig[] {
    const metrics = this.enabledMetrics(false);
    return this.t.bams_alert_configs.map((c) => ({
      id: c.id, name: c.name, metric_match: c.metric_match, rule_type: c.rule_type, operator: c.operator, threshold: c.threshold ?? null, reference_period: c.reference_period ?? null,
      consecutive_updates: c.consecutive_updates, severity: c.severity, cooldown_minutes: c.cooldown_minutes, enabled: !!c.enabled, starter: !!c.starter, row_version: c.row_version,
      preview: rulePreview('a matching metric', c as never),
      matches: metrics.filter((m) => globMatch(c.metric_match, m.metric_name)).length,
    }));
  }
  private configPlan(configId: string, metricIds: string[] | null | undefined) {
    const c = this.t.bams_alert_configs.find((x) => x.id === configId);
    if (!c) throw fail('not_found', 'Template not found.');
    let ms = this.enabledMetrics(false).filter((m) => globMatch(c.metric_match, m.metric_name));
    if (metricIds) {
      if (metricIds.some((id) => !ms.some((m) => m.id === id))) throw fail('validation_error', 'A selected metric does not match this template.');
      ms = ms.filter((m) => metricIds.includes(m.id));
    }
    const same = (r: Row) => r.rule_type === c.rule_type && r.operator === c.operator && (r.threshold ?? null) === (c.threshold ?? null) && (r.reference_period ?? null) === (c.reference_period ?? null)
      && r.consecutive_updates === c.consecutive_updates && r.severity === c.severity && r.cooldown_minutes === c.cooldown_minutes;
    const items = ms.map((m) => {
      const o = this.t.bams_objects.find((x) => x.id === m.object_id)!;
      const cl = this.t.clients.find((x) => x.id === o.client_id);
      return { metric_id: m.id as string, metric_name: m.metric_name as string, object_name: o.name as string, client_name: (cl?.name ?? '') as string, action: (this.t.bams_alert_rules.some((r) => r.metric_id === m.id && same(r)) ? 'skip_identical' : 'create') as 'create' | 'skip_identical' };
    });
    const hash = `sha256:${items.map((i) => `${i.metric_id}:${i.action}`).join('|')}`;
    return { c, items, hash };
  }
  previewConfig(configId: string, metricIds?: string[] | null): BamsConfigPreview {
    const { items, hash } = this.configPlan(configId, metricIds);
    return { config_id: configId, plan_hash: hash, would_create: items.filter((i) => i.action === 'create').length, skipped_identical: items.filter((i) => i.action === 'skip_identical').length, metrics: items };
  }
  applyConfig(configId: string, planHash: string, metricIds?: string[] | null): BamsConfigApplied {
    const { c, items, hash } = this.configPlan(configId, metricIds);
    if (hash !== planHash) throw fail('preview_stale', 'The metrics or rules changed since the preview. Preview again.');
    const ids: string[] = [];
    for (const i of items.filter((x) => x.action === 'create')) {
      ids.push(this.saveRule({
        metric_id: i.metric_id, rule_type: c.rule_type, operator: c.operator, threshold: c.threshold ?? null, reference_period: c.reference_period ?? null,
        consecutive_updates: c.consecutive_updates, severity: c.severity, cooldown_minutes: c.cooldown_minutes, enabled: !!c.enabled, suppress_until_clear: false,
      }).id);
    }
    return { created: ids.length, skipped_identical: items.length - ids.length, rule_ids: ids };
  }
}

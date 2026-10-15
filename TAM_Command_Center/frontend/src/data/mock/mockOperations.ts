// Mock Operations engine (docs/04_API_CONTRACT.md section 13). Derivation is computed on read from
// quarterly_upgrade_windows + bams_objects + server_upgrades, exactly like the backend.
import type { OpsApplianceInput, OpsData, OpsQuarter, OpsQuarterInput, OpsQuarterName, OpsQuery, OpsRow, OpsSetVersionResult, OpsStatus } from '../../opsTypes';
import { OPS_STATUSES } from '../../opsTypes';
import { DataSourceError } from '../DataSource';
import { defaultQuarter, deriveDate, deriveVersion, isOverdue, summarize } from '../../lib/operations';
import type { Row } from './rebase';

interface Ctx {
  t: Record<string, Row[]>; today: () => string; now: () => string; uuid: () => string;
  audit: (a: { client_id: string | null; object_type: string; object_id: string; object_label: string; action: string; old?: Row | null; new?: Row | null; reason?: string | null }) => void;
  backup: () => void;
}
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QN = ['Q1', 'Q2', 'Q3', 'Q4'];

export class MockOperations {
  constructor(private c: Ctx) {}

  private quarters(): OpsQuarter[] {
    const t = this.c.t;
    return (t.quarterly_upgrade_windows ?? [])
      .map((w): OpsQuarter => ({
        year: w.schedule_year, quarter: w.schedule_quarter, label: `${w.schedule_year} ${w.schedule_quarter}`, target_version: w.apics_version ?? null,
        dev_date: w.dev_upgrade_date ?? null, east_prod_date: w.east_prod_date ?? null, west_prod_date: w.west_prod_date ?? null, row_version: w.row_version ?? 1,
        records: (t.server_upgrades ?? []).filter((u) => u.schedule_year === w.schedule_year && u.schedule_quarter === w.schedule_quarter).length,
      }))
      .sort((a, b) => a.year * 4 + Number(a.quarter[1]) - (b.year * 4 + Number(b.quarter[1])));
  }
  private win(year: number, quarter: string): Row | undefined {
    return (this.c.t.quarterly_upgrade_windows ?? []).find((w) => w.schedule_year === year && w.schedule_quarter === quarter);
  }
  private record(obj: Row, year: number, quarter: string): Row | undefined {
    return (this.c.t.server_upgrades ?? []).find((u) => u.client_id === obj.client_id && lc(u.server_name) === lc(obj.name) && u.schedule_year === year && u.schedule_quarter === quarter);
  }
  private row(obj: Row, q: OpsQuarter): OpsRow {
    const clients = new Map<string, Row>(this.c.t.clients.map((c) => [c.id, c]));
    const rec = this.record(obj, q.year, q.quarter);
    const region = obj.region ?? null;
    const polarity = lc(region) === 'east' ? 'East' : lc(region) === 'west' ? 'West' : null;
    const env = obj.environment === 'PROD' || obj.environment === 'DEV' ? obj.environment : null;
    const date = deriveDate({ environment: env, polarity, quarter: q, override: rec?.scheduled_date ?? null });
    const status = (rec?.status ?? 'Planned') as OpsStatus;
    const problem = !env ? 'Set environment (PROD or DEV) first' : env === 'PROD' && !polarity ? 'Set East or West first' : null;
    return {
      object_id: obj.id, client_id: obj.client_id, client_name: clients.get(obj.client_id)?.name ?? '', appliance: obj.name, enabled: !!obj.enabled,
      environment: env, polarity, region, object_row_version: obj.row_version ?? 1,
      record_id: rec?.id ?? null, record_row_version: rec?.row_version ?? null, status, status_is_default: !rec, overdue: isOverdue(date.effective, status, this.c.today()),
      date: { effective: date.effective, source: date.source, override: rec?.scheduled_date ?? null, derived: date.derived, reason: date.reason },
      version: deriveVersion(rec?.target_version ?? null, q.target_version), notes: rec?.notes ?? null, can_record: !problem, record_problem: problem,
    };
  }

  get(query: OpsQuery): OpsData {
    const quarters = this.quarters();
    const today = this.c.today();
    let selected: OpsQuarter | null = null;
    let isDefault = false;
    if (query.year && query.quarter) selected = quarters.find((q) => q.year === query.year && q.quarter === query.quarter) ?? null;
    if (!selected) { selected = defaultQuarter(quarters, today); isDefault = true; }
    const objs = this.c.t.bams_objects ?? [];
    if (!selected) return { today, empty: 'no_quarters', quarters, selected: null, default_selected: true, appliance_total: objs.length, summary: summarize([]), groups: [] };
    const needle = lc(query.q);
    let rows = objs.map((o) => this.row(o, selected!));
    rows = rows.filter((r) =>
      (!query.status || r.status === query.status) &&
      (!query.environment || (query.environment === 'unset' ? !r.environment : r.environment === query.environment)) &&
      (!query.polarity || (query.polarity === 'unset' ? !r.polarity : r.polarity === query.polarity)) &&
      (!query.client_id || r.client_id === query.client_id) &&
      (!needle || lc(r.client_name).includes(needle) || lc(r.appliance).includes(needle)));
    const byClient = new Map<string, OpsRow[]>();
    for (const r of rows) byClient.set(r.client_id, [...(byClient.get(r.client_id) ?? []), r]);
    const groups = [...byClient.entries()].map(([client_id, rs]) => ({
      client_id, client_name: rs[0].client_name, count: rs.length, summary: summarize(rs),
      rows: rs.sort((a, b) => (a.date.effective ?? '9999').localeCompare(b.date.effective ?? '9999') || a.appliance.localeCompare(b.appliance)),
    })).sort((a, b) => a.client_name.localeCompare(b.client_name));
    return { today, empty: objs.length === 0 ? 'no_appliances' : null, quarters, selected, default_selected: isDefault, appliance_total: objs.length, summary: summarize(rows), groups };
  }

  saveQuarter(i: OpsQuarterInput): OpsQuarter {
    const fields: Record<string, string> = {};
    if (!Number.isInteger(i.year) || i.year < 2000 || i.year > 2100) fields.year = 'Year must be between 2000 and 2100.';
    if (!QN.includes(i.quarter)) fields.quarter = 'Choose Q1 to Q4.';
    for (const [k, v] of [['dev_upgrade_date', i.dev_upgrade_date], ['east_prod_date', i.east_prod_date], ['west_prod_date', i.west_prod_date]] as const) if (v && !DATE.test(v)) fields[k] = 'Use a valid date.';
    const ver = i.apics_version?.trim() || null;
    if (ver && ver.length > 50) fields.apics_version = 'Version is at most 50 characters.';
    if (Object.keys(fields).length) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', fields, 422);
    const w = this.win(i.year, i.quarter);
    const vals = { apics_version: ver, dev_upgrade_date: i.dev_upgrade_date || null, east_prod_date: i.east_prod_date || null, west_prod_date: i.west_prod_date || null };
    const label = `${i.year} ${i.quarter}`;
    if (i.expected_row_version === undefined) {
      if (w) throw new DataSourceError('conflict', `${label} already exists. Edit it instead.`, undefined, 409);
      this.c.t.quarterly_upgrade_windows.push({ schedule_year: i.year, schedule_quarter: i.quarter, ...vals, source_sync_method: 'manual', updated_at: this.c.now(), row_version: 1 });
      this.c.audit({ client_id: null, object_type: 'quarterly_upgrade_window', object_id: label, object_label: label, action: 'created', new: vals });
    } else {
      if (!w) throw new DataSourceError('not_found', `${label} was not found.`, undefined, 404);
      if (w.row_version !== i.expected_row_version) throw new DataSourceError('stale_write', 'This quarter changed since you opened it. Reload and try again.', undefined, 409);
      const old = { apics_version: w.apics_version, dev_upgrade_date: w.dev_upgrade_date, east_prod_date: w.east_prod_date, west_prod_date: w.west_prod_date };
      Object.assign(w, vals, { updated_at: this.c.now(), row_version: w.row_version + 1 });
      this.c.audit({ client_id: null, object_type: 'quarterly_upgrade_window', object_id: label, object_label: label, action: 'updated', old, new: vals });
    }
    return this.quarters().find((q) => q.year === i.year && q.quarter === i.quarter)!;
  }

  deleteQuarter(i: { year: number; quarter: OpsQuarterName; confirm: boolean }): void {
    const q = this.quarters().find((x) => x.year === i.year && x.quarter === i.quarter);
    if (!q) throw new DataSourceError('not_found', `${i.year} ${i.quarter} was not found.`, undefined, 404);
    if (q.records > 0) throw new DataSourceError('conflict', `${q.records} appliances have a status in this quarter`, undefined, 409, { records: q.records });
    if (!i.confirm) throw new DataSourceError('confirmation_required', 'Confirm to delete this quarter.', undefined, 409);
    this.c.backup();
    this.c.t.quarterly_upgrade_windows = this.c.t.quarterly_upgrade_windows.filter((w) => !(w.schedule_year === i.year && w.schedule_quarter === i.quarter));
    this.c.audit({ client_id: null, object_type: 'quarterly_upgrade_window', object_id: q.label, object_label: q.label, action: 'deleted' });
  }

  private ctxFor(objectId: string, year: number, quarter: string) {
    const obj = (this.c.t.bams_objects ?? []).find((o) => o.id === objectId);
    const q = this.quarters().find((x) => x.year === year && x.quarter === quarter);
    if (!obj || !q) throw new DataSourceError('not_found', !q ? `${year} ${quarter} was not found.` : 'Appliance not found.', undefined, 404);
    return { obj, q };
  }
  private mkRecord(obj: Row, q: OpsQuarter): Row {
    const r = this.row(obj, q);
    if (!r.environment) throw new DataSourceError('validation_error', 'Set Environment first.', { environment: 'Set Environment (PROD or DEV) first. Fix it on the appliance, then save again.' }, 422);
    if (r.environment === 'PROD' && !r.polarity) throw new DataSourceError('validation_error', 'Set East or West first.', { polarity: 'Set East or West first. Fix it on the appliance, then save again.' }, 422);
    const ts = this.c.now();
    const rec: Row = {
      id: this.c.uuid(), client_id: obj.client_id, server_name: obj.name, environment: r.environment, polarity: r.environment === 'DEV' ? 'DEV' : r.polarity,
      schedule_year: q.year, schedule_quarter: q.quarter, current_version: null, target_version: null, scheduled_date: null, status: 'Planned',
      validation_status: 'Pending', notes: null, created_at: ts, updated_at: ts, row_version: 1,
    };
    this.c.t.server_upgrades.push(rec);
    return rec;
  }

  saveAppliance(i: OpsApplianceInput): OpsRow {
    const { obj, q } = this.ctxFor(i.object_id, i.year, i.quarter);
    if (i.status !== undefined && !(OPS_STATUSES as readonly string[]).includes(i.status) && this.record(obj, i.year, i.quarter)?.status !== i.status) {
      throw new DataSourceError('validation_error', 'Unknown status.', { status: 'Choose a status from the list.' }, 422);
    }
    if (i.target_version && i.target_version.trim().length > 50) throw new DataSourceError('validation_error', 'Version is too long.', { target_version: 'Version is at most 50 characters.' }, 422);
    if (i.date_override && !DATE.test(i.date_override)) throw new DataSourceError('validation_error', 'Use a valid date.', { date_override: 'Use a valid date.' }, 422);
    let rec = this.record(obj, i.year, i.quarter);
    const patch: Row = {};
    if (i.status !== undefined) patch.status = i.status;
    if (i.date_override !== undefined) patch.scheduled_date = i.date_override || null;
    if (i.target_version !== undefined) patch.target_version = i.target_version?.trim() || null;
    if (i.notes !== undefined) patch.notes = i.notes?.trim() || null;
    if (rec) {
      if (i.expected_row_version !== undefined && rec.row_version !== i.expected_row_version) throw new DataSourceError('stale_write', 'This appliance changed since you opened it. Reload and try again.', undefined, 409);
    } else {
      const changes = Object.entries(patch).some(([k, v]) => v !== ({ status: 'Planned', scheduled_date: null, target_version: null, notes: null } as Row)[k]);
      if (!changes) return this.row(obj, q);
      rec = this.mkRecord(obj, q);
    }
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, rec![k]]));
    if (Object.keys(patch).some((k) => rec![k] !== patch[k])) {
      Object.assign(rec, patch, { updated_at: this.c.now(), row_version: rec.row_version + 1 });
      this.c.audit({ client_id: obj.client_id, object_type: 'server_upgrade', object_id: rec.id, object_label: obj.name, action: 'updated', old, new: patch });
    }
    return this.row(obj, q);
  }

  resetAppliance(i: { object_id: string; year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): OpsRow {
    const { obj, q } = this.ctxFor(i.object_id, i.year, i.quarter);
    const rec = this.record(obj, i.year, i.quarter);
    if (!rec) return this.row(obj, q);
    if (!i.confirm) throw new DataSourceError('confirmation_required', 'Confirm to reset this appliance to the quarter.', undefined, 409);
    if (i.expected_row_version !== undefined && rec.row_version !== i.expected_row_version) throw new DataSourceError('stale_write', 'This appliance changed since you opened it. Reload and try again.', undefined, 409);
    this.c.backup();
    this.c.t.server_upgrades = this.c.t.server_upgrades.filter((u) => u !== rec);
    this.c.audit({ client_id: obj.client_id, object_type: 'server_upgrade', object_id: rec.id, object_label: obj.name, action: 'deleted' });
    return this.row(obj, q);
  }

  setVersion(i: { year: number; quarter: OpsQuarterName; object_ids: string[]; target_version: string | null }): OpsSetVersionResult {
    const q = this.quarters().find((x) => x.year === i.year && x.quarter === i.quarter);
    if (!q) throw new DataSourceError('not_found', `${i.year} ${i.quarter} was not found.`, undefined, 404);
    if (!i.object_ids.length || i.object_ids.length > 500) throw new DataSourceError('validation_error', 'Choose between 1 and 500 appliances.', undefined, 422);
    const ver = i.target_version?.trim() || null;
    const out: OpsSetVersionResult = { target_version: ver, message: '', updated: [], unchanged: [], skipped: [] };
    const clients = new Map<string, Row>(this.c.t.clients.map((c) => [c.id, c]));
    for (const id of i.object_ids) {
      const obj = (this.c.t.bams_objects ?? []).find((o) => o.id === id);
      if (!obj) { out.skipped.push({ object_id: id, appliance: '', client_name: '', code: 'not_found', reason: 'Appliance not found' }); continue; }
      const tag = { object_id: id, appliance: obj.name, client_name: clients.get(obj.client_id)?.name ?? '' };
      let rec = this.record(obj, i.year, i.quarter);
      if (!rec) {
        if (!ver) { out.unchanged.push(tag); continue; }
        const r = this.row(obj, q);
        if (!r.environment) { out.skipped.push({ ...tag, code: 'needs_environment', reason: 'Set environment (PROD or DEV) first' }); continue; }
        if (!r.can_record) { out.skipped.push({ ...tag, code: 'needs_polarity', reason: 'Set East or West first' }); continue; }
        rec = this.mkRecord(obj, q);
      }
      if ((rec.target_version ?? null) === ver) { out.unchanged.push(tag); continue; }
      const old = rec.target_version;
      Object.assign(rec, { target_version: ver, updated_at: this.c.now(), row_version: rec.row_version + 1 });
      this.c.audit({ client_id: obj.client_id, object_type: 'server_upgrade', object_id: rec.id, object_label: obj.name, action: 'updated', old: { target_version: old }, new: { target_version: ver }, reason: 'set version' });
      out.updated.push(tag);
    }
    const reasons = [...new Set(out.skipped.map((s) => s.reason.toLowerCase()))];
    out.message = `${ver ? 'Version set' : 'Version cleared'} on ${out.updated.length}${out.skipped.length ? `; ${out.skipped.length} skipped: ${reasons.join('; ')}` : ''}`;
    return out;
  }
}

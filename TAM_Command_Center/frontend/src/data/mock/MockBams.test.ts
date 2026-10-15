// Mock BAMS adapter parity with docs/04_API_CONTRACT.md §11 (and §12 for the import): the rules the UI depends on.
import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../DataSource';
import { newMock } from './testFile';
import type { BamsImportPlan } from '../../bamsTypes';

async function code(p: Promise<unknown>): Promise<DataSourceError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(DataSourceError); return e as DataSourceError; }
  throw new Error('expected DataSourceError');
}
const csv = (rows: string[]) => new File([`Account,BPID,Appliance,Metric,Ticker,Region,Location,Environment,Enabled,Stale after (s)\n${rows.join('\n')}\n`], 'import.csv', { type: 'text/csv' });

describe('state', () => {
  it('summary, view counts and rows agree; worst status sorts first', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({});
    expect(s.summary.total).toBe(s.rows.length);
    expect(s.summary.active_alerts).toBe(s.summary.open + s.summary.recovered);
    expect(s.view_counts.all).toBe(s.rows.length);
    expect(s.view_counts.active_alerts).toBe(s.rows.filter((r) => r.active_alerts > 0).length);
    const rank = { open: 0, recovered: 1, stale: 2, no_data: 3, delayed: 4, live: 5, disabled: 6 } as const;
    const ranks = s.rows.map((r) => rank[r.display_status]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(s.provider).toMatchObject({ mode: 'DEV', simulated: true });
    expect(s.banner).toBeNull();
  });
  it('filters combine with AND, search is case-insensitive, account accepts a list, view_counts ignore only the view', async () => {
    const ds = newMock();
    const all = await ds.getBamsState({});
    const acct = all.filters.accounts[0];
    const one = await ds.getBamsState({ account: acct.id, q: 'CPU' });
    expect(one.rows.every((r) => r.object.client_id === acct.id && /cpu/i.test(`${r.metric_name}${r.ticker}${r.object.name}`))).toBe(true);
    const two = await ds.getBamsState({ account: `${all.filters.accounts[0].id},${all.filters.accounts[1].id}` });
    expect(new Set(two.rows.map((r) => r.object.client_id)).size).toBe(2);
    const alerts = await ds.getBamsState({ view: 'active_alerts', account: acct.id });
    expect(alerts.view_counts.all).toBe((await ds.getBamsState({ account: acct.id })).rows.length);
  });
  it('sorts by a column with nulls last and honours dir', async () => {
    const ds = newMock();
    const asc = (await ds.getBamsState({ sort: 'current', dir: 'asc' })).rows.map((r) => r.current_value);
    const nums = asc.filter((v): v is number => v != null);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    const desc = (await ds.getBamsState({ sort: 'current', dir: 'desc' })).rows.map((r) => r.current_value).filter((v): v is number => v != null);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
  });
  it('PROD provider unavailable: every row is No Data with no number, never simulated', async () => {
    const ds = newMock({ bamsProvider: 'unavailable' });
    const s = await ds.getBamsState({});
    expect(s.provider).toMatchObject({ mode: 'PROD', available: false, simulated: false });
    expect(s.banner?.code).toBe('provider_unavailable');
    expect(s.monitor.state).toBe('provider_unavailable');
    expect(s.rows.every((r) => r.current_value === null && r.freshness === 'No Data' && r.simulated === false && (r.spark ?? []).length === 0)).toBe(true);
    const t = await ds.getBamsTrend(s.rows[0].id, '7d');
    expect(t.points).toEqual([]);
    expect(t.text.count).toBe(0);
  });
});

describe('monitor and settings', () => {
  it('start and stop persist desired_running; settings validate the poll interval and change only sent keys', async () => {
    const ds = newMock();
    expect((await ds.setBamsMonitor(false)).monitor.state).toBe('stopped');
    expect((await ds.getBamsMonitor()).monitor.desired_running).toBe(false);
    expect((await ds.setBamsMonitor(true)).monitor.state).toBe('running');
    expect((await code(ds.saveBamsSettings({ poll_interval_seconds: 10 }))).fields?.poll_interval_seconds).toBeTruthy();
    const saved = await ds.saveBamsSettings({ poll_interval_seconds: 300, privacy_mode: false });
    expect(saved).toMatchObject({ poll_interval_seconds: 300, privacy_mode: false, desktop_notifications: true });
    expect((await ds.getBamsState({})).monitor.freshness.live_seconds).toBe(315);
  });
  it('PROD stub: start is accepted but the monitor stays provider_unavailable', async () => {
    const ds = newMock({ bamsProvider: 'unavailable' });
    expect((await ds.setBamsMonitor(true)).monitor.state).toBe('provider_unavailable');
  });
});

describe('alerts and Close', () => {
  it('lists active first, Close needs no row_version, writes a note, drops the count and notifies once', async () => {
    const ds = newMock();
    const before = await ds.getBamsAlerts({ status: 'all' });
    const active = before.items.filter((i) => i.event.status !== 'closed');
    expect(active.length).toBe(before.counts.active);
    expect(before.items.slice(0, active.length).every((i) => i.event.status !== 'closed')).toBe(true);
    const target = active[0];
    const r = await ds.closeBamsAlert({ id: target.event.id, note: '  batch job  ' });
    expect(r.event).toMatchObject({ status: 'closed', closed_note: 'batch job', still_breaching: false });
    const after = await ds.getBamsAlerts({ status: 'all' });
    expect(after.counts.active).toBe(before.counts.active - 1);
    expect(after.counts.closed).toBe(before.counts.closed + 1);
    expect((await code(ds.closeBamsAlert({ id: target.event.id, note: null }))).details?.reason).toBe('already_closed');
    expect((await ds.getBamsNotifications()).items[0]).toMatchObject({ kind: 'closed', event_id: target.event.id });
    expect((await code(ds.closeBamsAlert({ id: 'nope', note: null }))).code).toBe('not_found');
  });
  it('a note over 2000 characters is refused', async () => {
    const ds = newMock();
    const open = (await ds.getBamsAlerts({})).items[0];
    expect((await code(ds.closeBamsAlert({ id: open.event.id, note: 'x'.repeat(2001) }))).code).toBe('validation_error');
  });
  it('unread count follows the watermark and mark-all clears it', async () => {
    const ds = newMock();
    const n = await ds.getBamsNotifications();
    expect(n.unread_count).toBeGreaterThan(0);
    expect(await ds.markBamsNotificationsRead({ all: true })).toBe(0);
  });
});

describe('appliances and metrics', () => {
  const base = { region: 'Americas', location: 'New York', environment: 'PROD' as const, enabled: true };
  it('create needs a metric; duplicate name per account and ticker are field conflicts naming the owner', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({});
    const owner = s.rows[0];
    const cid = owner.object.client_id;
    expect((await code(ds.saveBamsObject({ ...base, client_id: cid, name: 'NEW-1', metrics: [] }))).fields?.metrics).toBeTruthy();
    expect((await code(ds.saveBamsObject({ ...base, client_id: cid, name: owner.object.name.toUpperCase(), metrics: [{ metric_name: 'm', ticker: 'T-NEW' }] }))).fields?.name).toMatch(/already exists for this account/);
    const e = await code(ds.saveBamsObject({ ...base, client_id: cid, name: 'NEW-1', metrics: [{ metric_name: 'm', ticker: owner.ticker.toLowerCase() }] }));
    expect(e.fields?.['metrics[0].ticker']).toMatch(new RegExp(`already used by ${owner.metric_name.replace(/[()%]/g, '.')}`));
    expect((await code(ds.saveBamsObject({ ...base, client_id: cid, name: 'NEW-1', metrics: [{ metric_name: 'a', ticker: 'DUP' }, { metric_name: 'b', ticker: 'dup' }] }))).fields?.['metrics[1].ticker']).toBeTruthy();
  });
  it('a new metric shows No Data until the next poll', async () => {
    const ds = newMock();
    const cid = (await ds.getBamsState({})).filters.accounts[0].id;
    const saved = await ds.saveBamsObject({ ...base, client_id: cid, name: 'NEW-OK', metrics: [{ metric_name: 'CPU utilisation %', ticker: 'NEW OK CPU' }] });
    const row = (await ds.getBamsState({ object_id: saved.item.id })).rows[0];
    expect(row).toMatchObject({ freshness: 'No Data', current_value: null, display_status: 'no_data' });
  });
  it('delete preview counts, blocks while an alert is open or recovered, then deletes everything underneath', async () => {
    const ds = newMock();
    const withAlert = (await ds.getBamsState({ view: 'active_alerts' })).rows[0];
    const p = await ds.getBamsDeletePreview('object', withAlert.object.id);
    expect(p).toMatchObject({ blocked: true });
    expect(p.blocked_reason).toMatch(/still open or recovered/);
    expect((await code(ds.deleteBamsItem('object', { id: withAlert.object.id }))).details?.reason).toBe('active_alert');
    const clean = (await ds.getBamsState({})).rows.find((r) => r.active_alerts === 0 && r.alert === null)!;
    const q = await ds.getBamsDeletePreview('metric', clean.id);
    expect(q.blocked).toBe(false);
    const total = (await ds.getBamsState({})).summary.total;
    await ds.deleteBamsItem('metric', { id: clean.id });
    expect((await ds.getBamsState({})).summary.total).toBe(total - 1);
    expect((await code(ds.getBamsMetric(clean.id))).code).toBe('not_found');
  });
});

describe('rules and templates', () => {
  const metricId = async (ds: ReturnType<typeof newMock>) => (await ds.getBamsState({})).rows[0].id;
  it('validation messages per rule type', async () => {
    const ds = newMock();
    const metric_id = await metricId(ds);
    const mk = (o: object) => ds.saveBamsRule({ metric_id, rule_type: 'fixed_threshold', operator: '>', threshold: 85, reference_period: null, consecutive_updates: 1, severity: 'Warning', cooldown_minutes: 15, enabled: true, suppress_until_clear: false, ...o } as never);
    expect((await code(mk({ threshold: null }))).fields?.threshold).toBe('Threshold is required for a threshold rule.');
    expect((await code(mk({ consecutive_updates: 0 }))).fields?.consecutive_updates).toBe('Consecutive updates must be 1 or more.');
    expect((await code(mk({ rule_type: 'pct_of_high', threshold: 0, reference_period: '90d' }))).fields?.threshold).toBeTruthy();
    expect((await code(mk({ rule_type: 'exceeds_high', threshold: null, reference_period: '90d', operator: '<' }))).fields?.operator).toBeTruthy();
    const ok = await mk({ rule_type: 'pct_of_high', threshold: 90, reference_period: '90d' });
    expect(ok.preview).toMatch(/^Alerts when .* > 90% of the 90-day high/);
    expect(ok.enabled).toBe(true);
  });
  it('deleting a rule with an open alert is blocked', async () => {
    const ds = newMock();
    const open = (await ds.getBamsAlerts({})).items.find((i) => i.event.rule_id)!;
    expect((await code(ds.deleteBamsRule({ id: open.event.rule_id! }))).details?.reason).toBe('active_alert');
  });
  it('template apply: preview writes nothing, the hash is required, identical rules are skipped, never duplicated', async () => {
    const ds = newMock();
    const cfg = (await ds.getBamsConfigs())[0];
    const p = await ds.previewBamsConfig({ config_id: cfg.id });
    expect(p.would_create + p.skipped_identical).toBe(cfg.matches);
    const rulesBefore = async () => (await ds.getBamsState({})).rows.length;
    void rulesBefore;
    expect((await code(ds.applyBamsConfig({ config_id: cfg.id, plan_hash: 'wrong' }))).code).toBe('preview_stale');
    const done = await ds.applyBamsConfig({ config_id: cfg.id, plan_hash: p.plan_hash });
    expect(done.created).toBe(p.would_create);
    const again = await ds.previewBamsConfig({ config_id: cfg.id });
    expect(again.would_create).toBe(0);
    expect(again.skipped_identical).toBe(cfg.matches);
  });
  it('trend: text equivalent is exact, reference lines carry the highs, rule lines have a number', async () => {
    const ds = newMock();
    const row = (await ds.getBamsState({ sort: 'appliance' })).rows.find((r) => r.highs.d90.value != null)!;
    const t = await ds.getBamsTrend(row.id, '90d');
    expect(t.reference_lines.map((l) => l.id)).toEqual(['high_30', 'high_60', 'high_90']);
    if (t.points.length) {
      expect(t.text.min).toBeLessThanOrEqual(t.text.last!);
      expect(t.text.max).toBeGreaterThanOrEqual(t.text.last!);
      expect(t.points.length).toBeLessThanOrEqual(500);
    }
    expect(t.rule_lines.every((l) => typeof l.value === 'number')).toBe(true);
  });
});

describe('appliance import (contract §12)', () => {
  const inspect = (ds: ReturnType<typeof newMock>, rows: string[]) => ds.inspectBamsImport(csv(rows));
  async function fixture(ds: ReturnType<typeof newMock>) {
    const s = await ds.getBamsState({});
    const r = s.rows[0];
    const acct = r.object.client_name;
    return { acct, existingApp: r.object.name, existingMetric: r.metric_name, existingTicker: r.ticker, otherTicker: s.rows[1].ticker, region: r.object.region };
  }
  it('classifies rows into five disjoint states, never writes at inspect, and a header-less file is refused with details', async () => {
    const ds = newMock();
    const f = await fixture(ds);
    const total = (await ds.getBamsState({})).summary.total;
    const p = await inspect(ds, [
      `${f.acct},,NEW-APP-1,CPU utilisation %,IMP.NEW1.CPU,,,PROD,,`,
      `${f.acct},,${f.existingApp},${f.existingMetric},${f.existingTicker},,,,,`,
      `${f.acct},,${f.existingApp},Brand new metric,IMP.NEWM,,,,,`,
      `${f.acct},,APP-X,CPU,${f.otherTicker},,,,,`,
      `Nope Capital,,APP-Y,CPU,IMP.Y,,,,,`,
      `${f.acct},,APP-Z,CPU,IMP.Z,,,STAGING,,`,
    ]);
    const states = p.rows.map((r) => r.state);
    expect(states).toEqual(['new', 'unchanged', 'new', 'invalid', 'invalid', 'invalid']);
    expect(p.counts).toMatchObject({ rows: 6, valid: 3, new: 2, unchanged: 1, invalid: 3, needs_review: 0 });
    expect(p.rows[3].errors[0].code).toBe('ticker_conflict');
    expect(p.rows[4].errors[0].code).toBe('account_not_found');
    expect(p.rows[5].errors[0].code).toBe('environment_invalid');
    expect((await ds.getBamsState({})).summary.total).toBe(total);
    const bad = await code(ds.inspectBamsImport(new File(['Account,Appliance,Metric\nA,B,C\n'], 'x.csv', { type: 'text/csv' })));
    expect(bad.details).toMatchObject({ reason: 'header_missing', missing: ['Ticker'] });
  });
  it('repeats, repeated tickers and a differing ticker for an existing metric are Invalid; formulas never read', async () => {
    const ds = newMock();
    const f = await fixture(ds);
    const p = await inspect(ds, [
      `${f.acct},,APP-R,CPU,IMP.R1,,,,,`,
      `${f.acct},,APP-R,CPU,IMP.R1,,,,,`,
      `${f.acct},,APP-S,CPU,IMP.SAME,,,,,`,
      `${f.acct},,APP-S,Mem,IMP.SAME,,,,,`,
      `${f.acct},,${f.existingApp},${f.existingMetric},IMP.DIFFERENT,,,,,`,
    ]);
    expect(p.rows.map((r) => r.errors[0]?.code ?? r.state)).toEqual(['new', 'repeats_row', 'ticker_repeated_in_file', 'ticker_repeated_in_file', 'ticker_differs']);
  });
  it('a similar appliance in the same account is flagged per appliance, nothing preselected; Apply is gated and writes what was decided', async () => {
    const ds = newMock();
    const p = await inspect(ds, [
      'Bluewater Reach Securities,,brs-bpipe-ny-1,CPU Utilization (%),IMP.SIM1,,,,,',
      'Bluewater Reach Securities,,brs-bpipe-ny-1,Extra metric,IMP.SIM2,,,,,',
      'Aurelian Vale Commodities,,brs-bpipe-ny-1,CPU,IMP.OTHER,,,,,', // same name under another account is independent
    ]);
    expect(p.counts).toMatchObject({ needs_review: 2, new: 1 });
    expect(p.review).toHaveLength(1);
    expect(p.review[0]).toMatchObject({ rows: [2, 3], client_name: 'Bluewater Reach Securities' });
    expect(p.review[0].candidates[0].name).toBe('brs-bpipe-ny-01');
    expect(p.review[0].candidates[0].metrics_added).toEqual(['Extra metric']);
    expect(p.review[0].candidates[0].metrics_existing).toEqual(['CPU Utilization (%)']);
    const err = await code(ds.applyBamsImport({ import_id: p.import_id, plan_hash: p.plan_hash, confirm: true, decisions: [] }));
    expect(err.code).toBe('unresolved_duplicates');
    expect(err.details?.keys).toEqual([p.review[0].key]);
    const cand = p.review[0].candidates[0];
    const r = await ds.applyBamsImport({ import_id: p.import_id, plan_hash: p.plan_hash, confirm: true, decisions: [{ key: p.review[0].key, choice: 'same', target: cand.ref }] });
    expect(r.counts).toMatchObject({ appliances_created: 1, appliances_updated: 1, metrics_created: 2, overwritten: 0 }); // Aurelian appliance + merged extra metric + its metric
    expect(r.decisions[0]).toMatchObject({ choice: 'same', label: 'brs-bpipe-ny-1 merged into brs-bpipe-ny-01' });
    expect(r.backup?.reason).toBe('pre-import');
    const target = cand.ref.type === 'appliance' ? cand.ref.id : '';
    const names = (await ds.getBamsState({ object_id: target })).rows.map((x) => x.metric_name);
    expect(names).toContain('Extra metric');
  });
  it('apply: creates, never overwrites, drives Open BAMS, and a second apply is already_applied; re-import writes nothing', async () => {
    const ds = newMock();
    const f = await fixture(ds);
    const rows = [`${f.acct},,APP-OK,CPU utilisation %,IMP.OK1,EMEA,Paris,DEV,,300`, `${f.acct},,APP-OK,Disk,IMP.OK2,,,,No,`, 'Nope Capital,,APP-Y,CPU,IMP.Y,,,,,'];
    const p: BamsImportPlan = await inspect(ds, rows);
    const r = await ds.applyBamsImport({ import_id: p.import_id, plan_hash: p.plan_hash, confirm: true, decisions: [] });
    expect(r.counts).toMatchObject({ appliances_created: 1, metrics_created: 2, skipped: 1, invalid: 1, overwritten: 0 });
    expect(r.touched_accounts).toHaveLength(1);
    expect(r.skipped_url).toBeTruthy();
    const created = (await ds.getBamsState({ object_id: r.created[0].id, include_disabled: true })).rows;
    expect(created.map((c) => [c.metric_name, c.enabled, c.stale_after_seconds])).toEqual(expect.arrayContaining([['CPU utilisation %', true, 300], ['Disk', false, 120]]));
    expect((await code(ds.applyBamsImport({ import_id: p.import_id, plan_hash: p.plan_hash, confirm: true, decisions: [] }))).code).toBe('already_applied');
    const again = await inspect(ds, rows.slice(0, 2));
    expect(again.counts).toMatchObject({ new: 0, unchanged: 2, invalid: 0 });
    const noop = await ds.applyBamsImport({ import_id: again.import_id, plan_hash: again.plan_hash, confirm: true, decisions: [] });
    expect(noop.backup).toBeNull();
    expect(noop.counts).toMatchObject({ appliances_created: 0, metrics_created: 0 });
    const skipped = await ds.downloadBamsSkippedRows(p.import_id, 'csv');
    expect(skipped.filename).toBe('tam_bams_skipped.csv');
  });
  it('a stale plan hash is refused and an unknown import is expired', async () => {
    const ds = newMock();
    const f = await fixture(ds);
    const p = await inspect(ds, [`${f.acct},,APP-ST,CPU,IMP.ST,,,,,`]);
    expect((await code(ds.applyBamsImport({ import_id: p.import_id, plan_hash: 'mock:bad', confirm: true, decisions: [] }))).code).toBe('preview_stale');
    expect((await code(ds.getBamsImport('missing'))).code).toBe('import_expired');
  });
});

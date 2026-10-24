// ApiDataSource: BAMS routes (docs/04_API_CONTRACT.md §11, §12). Request shapes and mapping only; the backend owns the rules.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiDataSource, mapBamsPlan, mapBamsRow } from './ApiDataSource';
import { DataSourceError } from './DataSource';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; blob?: Blob };
function stub(handler: (url: string, init?: RequestInit) => Reply) {
  const calls: { url: string; init?: RequestInit; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const r = handler(url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: new Headers(r.headers), json: async () => r.body, blob: async () => r.blob ?? new Blob(['x']) } as unknown as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const row = { id: 'm1', metric_name: 'CPU %', ticker: 'T1', enabled: 1, stale_after_seconds: 120, row_version: 1, object: { id: 'o', name: 'O', client_id: 'c', client_name: 'C', region: null, location: null, environment: 'PROD', enabled: 1, row_version: 1 }, current_value: null, simulated: 0, freshness: 'No Data', highs: { d30: { value: null, date: null }, d60: { value: null, date: null }, d90: { value: null, date: null } }, alert: null, active_alerts: 0, display_status: 'no_data' };

describe('state and detail', () => {
  it('sends only the set filters, sort and view, and maps 0/1 to booleans', async () => {
    const calls = stub(() => ({ body: { ok: true, rows: [row], summary: {}, monitor: {}, provider: {}, filters: {}, view_counts: {}, counts: {} } }));
    const ds = new ApiDataSource();
    const s = await ds.getBamsState({ view: 'active_alerts', account: 'a,b', q: 'cpu', sort: 'high90', dir: 'desc', spark: false });
    expect(calls[0].url).toBe('/api/bams/state?view=active_alerts&account=a%2Cb&q=cpu&sort=high90&dir=desc&spark=0');
    expect(s.rows[0]).toMatchObject({ enabled: true, simulated: false, spark: [] });
    expect(s.rows[0].object.enabled).toBe(true);
    expect(mapBamsRow(row as never).spark).toEqual([]);
  });
  it('trend and alerts use the documented paths and query names', async () => {
    const calls = stub((u) => ({ body: u.includes('/trend') ? { item: { points: [] } } : { counts: {}, items: [{ event: { still_breaching: 1 } }] } }));
    const ds = new ApiDataSource();
    await ds.getBamsTrend('m 1', '30d');
    expect(calls[0].url).toBe('/api/bams/metric/m%201/trend?range=30d');
    await ds.getBamsTrendWindow('m 1', '2026-10-14T01:00:00.000Z', '2026-10-14T02:00:00.000Z');
    expect(calls[1].url).toBe('/api/bams/metric/m%201/trend?from=2026-10-14T01%3A00%3A00.000Z&to=2026-10-14T02%3A00%3A00.000Z');
    const a = await ds.getBamsAlerts({ status: 'all', account: 'c', limit: 200 });
    expect(calls[2].url).toBe('/api/bams/alerts?status=all&account=c&limit=200');
    expect(a.items[0].event.still_breaching).toBe(true);
  });
});

describe('writes', () => {
  it('Close sends only the note (no expected_row_version, §11.12 0c)', async () => {
    const calls = stub(() => ({ body: { ok: true, item: { event: { id: 'e', still_breaching: 0 }, suppressed_until_clear: true } } }));
    const r = await new ApiDataSource().closeBamsAlert({ id: 'e1', note: 'n' });
    expect(calls[0].url).toBe('/api/bams/alert/e1/close');
    expect(calls[0].body).toEqual({ note: 'n' });
    expect(r.suppressed_until_clear).toBe(true);
  });
  it('monitor start and stop, settings partial body', async () => {
    const calls = stub(() => ({ body: { ok: true, item: { monitor: { state: 'running' } } } }));
    const ds = new ApiDataSource();
    await ds.setBamsMonitor(true);
    await ds.setBamsMonitor(false);
    await ds.saveBamsSettings({ privacy_mode: false });
    expect(calls.map((c) => c.url)).toEqual(['/api/bams/monitor/start', '/api/bams/monitor/stop', '/api/bams/settings']);
    expect(calls[0].body).toEqual({});
    expect(calls[2].body).toEqual({ privacy_mode: false });
  });
  it('delete always sends confirm:true; a blocked delete surfaces details.reason', async () => {
    const calls = stub((u) => (u.includes('/object/delete') ? { status: 409, body: { ok: false, error: { code: 'conflict', message: 'blocked', details: { reason: 'active_alert' } } } } : { body: { ok: true, item: { deleted: {} } } }));
    const ds = new ApiDataSource();
    await ds.deleteBamsItem('metric', { id: 'm', expected_row_version: 2 });
    expect(calls[0].body).toEqual({ id: 'm', expected_row_version: 2, confirm: true });
    const e = await ds.deleteBamsItem('object', { id: 'o' }).catch((x) => x as DataSourceError);
    expect(e).toBeInstanceOf(DataSourceError);
    expect((e as DataSourceError).details).toEqual({ reason: 'active_alert' });
  });
  it('object save keeps field errors for the dialog (name and metrics[i].ticker)', async () => {
    stub(() => ({ status: 409, body: { ok: false, error: { code: 'conflict', message: 'x', fields: { 'metrics[1].ticker': 'Ticker T is already used by A on B.' } } } }));
    const e = await new ApiDataSource().saveBamsObject({ name: 'n', region: null, location: null, environment: null, enabled: true, metrics: [] }).catch((x) => x as DataSourceError);
    expect((e as DataSourceError).fields?.['metrics[1].ticker']).toMatch(/already used/);
  });
  it('template apply: preview first, then confirm with the plan hash', async () => {
    const calls = stub(() => ({ body: { ok: true, item: {} } }));
    const ds = new ApiDataSource();
    await ds.previewBamsConfig({ config_id: 'c' });
    await ds.applyBamsConfig({ config_id: 'c', plan_hash: 'sha256:x' });
    expect(calls[0].body).toEqual({ config_id: 'c', metric_ids: null, preview: true, confirm: false });
    expect(calls[1].body).toEqual({ config_id: 'c', metric_ids: null, plan_hash: 'sha256:x', preview: false, confirm: true });
  });
  it('rules: save is a plain upsert, delete confirms', async () => {
    const calls = stub((u) => ({ body: { ok: true, item: u.endsWith('/save') ? { rule: { id: 'r', enabled: 1, suppress_until_clear: 0 } } : {} } }));
    const ds = new ApiDataSource();
    const r = await ds.saveBamsRule({ metric_id: 'm', rule_type: 'fixed_threshold', operator: '>', threshold: 85, reference_period: null, consecutive_updates: 3, severity: 'Warning', cooldown_minutes: 15, enabled: true, suppress_until_clear: false });
    await ds.deleteBamsRule({ id: 'r', expected_row_version: 4 });
    expect(r).toMatchObject({ enabled: true, suppress_until_clear: false });
    expect(calls[1].body).toEqual({ id: 'r', expected_row_version: 4, confirm: true });
  });
  it('notifications: unread watermark body is exactly one of through_id or all', async () => {
    const calls = stub((u) => ({ body: u.includes('/read') ? { ok: true, item: { unread_count: 0 } } : { ok: true, unread_count: 2, items: [{ id: 1, unread: 1 }] } }));
    const ds = new ApiDataSource();
    expect((await ds.getBamsNotifications(10)).items[0].unread).toBe(true);
    expect(calls[0].url).toBe('/api/bams/notifications?limit=10');
    expect(await ds.markBamsNotificationsRead({ all: true })).toBe(0);
    expect(calls[1].body).toEqual({ all: true });
  });
});

describe('appliance import', () => {
  const plan = { import_id: 'i', plan_hash: 'sha256:1', expires_at: 'z', file: { name: 'f.xlsx', size_bytes: 3, format: 'xlsx', sheet: 'Import', rows_found: 1, encoding: null, delimiter: null, notes: [] }, limits: {}, counts: {}, appliances: {}, metrics: {}, rows: [{ row: 2, state: 'new', values: {}, raw: null, target: null, group: 'g2', review_key: null }], review: [{ key: 'g2', candidates: [{ ref: { type: 'appliance', id: 'a' }, name: 'A', strength: 'High' }] }] };
  it('inspect posts the raw bytes with an encoded file name; apply and template/skipped use the §12 paths', async () => {
    const calls = stub((u) => ({ body: { ok: true, item: u.includes('/apply') ? { import_id: 'i', counts: {} } : plan }, headers: { 'Content-Disposition': 'attachment; filename="tam_bams_import_template.csv"' } }));
    const ds = new ApiDataSource();
    const csv = new File(['Account,BPID,Appliance,Metric,Ticker\n'], 'my bams.csv', { type: 'text/csv' });
    const p = await ds.inspectBamsImport(csv);
    expect(calls[0].url).toBe('/api/import/bams/inspect');
    expect((calls[0].init?.headers as Record<string, string>)['X-File-Name']).toBe('my%20bams.csv');
    expect(p.review[0].candidates[0]).toMatchObject({ reasons: [], metrics_added: [], metrics_conflicts: [], fills: {} });
    await ds.applyBamsImport({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [{ key: 'g2', choice: 'skip' }] });
    expect(calls[1].url).toBe('/api/import/bams/apply');
    expect(calls[1].body).toEqual({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [{ key: 'g2', choice: 'skip' }] });
    const t = await ds.downloadBamsImportTemplate('csv');
    expect(calls[2].url).toBe('/api/import/bams/template?format=csv');
    expect(t.filename).toBe('tam_bams_import_template.csv');
    await ds.downloadBamsSkippedRows('i', 'xlsx');
    expect(calls[3].url).toBe('/api/import/bams/i/skipped.xlsx');
  });
  it('import_failed keeps its details for mockup 12B; a refused file never reaches the network', async () => {
    const calls = stub(() => ({ status: 500, body: { ok: false, error: { code: 'import_failed', message: 'rolled back', details: { rolled_back: true, row: 14, reason: 'r', backup: 'b.db' } } } }));
    const ds = new ApiDataSource();
    const e = await ds.applyBamsImport({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [] }).catch((x) => x as DataSourceError);
    expect((e as DataSourceError).code).toBe('import_failed');
    expect((e as DataSourceError).details).toMatchObject({ row: 14, backup: 'b.db' });
    const bad = await ds.inspectBamsImport(new File(['%PDF-1.4'], 'x.pdf')).catch((x) => x as DataSourceError);
    expect((bad as DataSourceError).code).toBe('invalid_file');
    expect(calls).toHaveLength(1);
  });
  it('mapBamsPlan fills defaults for optional arrays', () => {
    const m = mapBamsPlan({ ...(plan as object), warnings: undefined } as never);
    expect(m.warnings).toEqual([]);
    expect(m.rows[0]).toMatchObject({ errors: [], warnings: [], notes: [], fills: {}, kept: {} });
  });
});

// ApiDataSource: Operations routes (docs/04_API_CONTRACT.md section 13). Request shapes only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiDataSource } from './ApiDataSource';
import { DataSourceError } from './DataSource';

function stub(handler: (url: string) => { status?: number; body: unknown }) {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const r = handler(url);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as unknown as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('operations adapter', () => {
  it('sends only the set query params and drops the envelope flag', async () => {
    const calls = stub(() => ({ body: { ok: true, today: '2026-10-14', empty: null, quarters: [], selected: null, default_selected: true, appliance_total: 0, summary: { total: 0, by_status: {}, overdue: 0 }, groups: [] } }));
    const d = await new ApiDataSource().getOperations({ year: 2026, quarter: 'Q4', q: ' acme ', status: 'Planned', environment: 'unset' });
    expect(calls[0].url).toBe('/api/operations?year=2026&quarter=Q4&q=acme&status=Planned&environment=unset');
    expect('ok' in d).toBe(false);
  });
  it('posts the documented bodies and unwraps item', async () => {
    const calls = stub(() => ({ body: { ok: true, item: { target_version: '1', message: 'm', updated: [], unchanged: [], skipped: [] } } }));
    const ds = new ApiDataSource();
    await ds.setOperationsVersion({ year: 2026, quarter: 'Q4', object_ids: ['a'], target_version: null });
    await ds.deleteOperationsQuarter({ year: 2026, quarter: 'Q4', confirm: true });
    expect(calls.map((c) => c.url)).toEqual(['/api/operations/appliance/set-version', '/api/operations/quarter/delete']);
    expect(calls[0].body).toEqual({ year: 2026, quarter: 'Q4', object_ids: ['a'], target_version: null });
  });
  it('maps the delete-blocked conflict with its details', async () => {
    stub(() => ({ status: 409, body: { ok: false, error: { code: 'conflict', message: '3 appliances have a status in this quarter', details: { records: 3 } } } }));
    const e = await new ApiDataSource().deleteOperationsQuarter({ year: 2026, quarter: 'Q4', confirm: true }).catch((x) => x);
    expect(e).toBeInstanceOf(DataSourceError);
    expect(e).toMatchObject({ code: 'conflict', details: { records: 3 }, message: '3 appliances have a status in this quarter' });
  });
});

// ApiDataSource: the import routes (docs/04_API_CONTRACT.md §10). Uploads and downloads stay inside src/data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiDataSource, mapPlan } from './ApiDataSource';
import { DataSourceError } from './DataSource';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; blob?: Blob };
function stub(handler: (url: string, init?: RequestInit) => Reply) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    const h = new Headers(r.headers);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: h, json: async () => r.body, blob: async () => r.blob ?? new Blob(['x']) } as unknown as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const wirePlan = {
  import_id: 'b6f1', plan_hash: 'sha256:abc', expires_at: '2026-10-13T15:12:00.000Z',
  file: { name: 'q4.csv', size_bytes: 120, rows_found: 2, sheet: 'CSV', format: 'csv', encoding: 'UTF-8', delimiter: 'semicolon', notes: ['Read as CSV: encoding UTF-8, delimiter semicolon.'] },
  limits: { max_rows: 500, max_candidates: 5 }, counts: { rows: 2, valid: 2, new: 1, updates: 0, needs_review: 1, invalid: 0 }, warnings: [{ code: 'csv_delimiter', text: 'Semicolons.' }],
  rows: [
    { row: 2, state: 'new', values: { name: 'A', bpid: null, products: null, status: 'Active', next_contact: null, notes: null }, errors: [], warnings: [], match: null, candidates: [] },
    {
      row: 3, state: 'needs_review', values: { name: 'Web Ltd', bpid: '1', products: null, status: null, next_contact: null, notes: null }, errors: [], warnings: [], match: null, score: 88,
      candidates: [{ ref: { type: 'account', id: 'x' }, name: 'Web Mgmt Ltd', bpid: '1', strength: 'High', similarity: 88, percent: 88, score: 88, reasons: [{ code: 'contained_name', text: 'Every word', points: 3 }], differences: [], fills: {}, kept: {}, notes: [] }],
    },
  ],
};

describe('ApiDataSource import routes', () => {
  it('maps the plan to domain types and drops any numeric score, similarity or percentage (D-42)', () => {
    const p = mapPlan(wirePlan as never);
    const c = p.rows[1].candidates[0];
    expect(Object.keys(c).sort()).toEqual(['bpid', 'differences', 'fills', 'kept', 'name', 'next_contact', 'notes', 'products', 'reasons', 'ref', 'row_version', 'status', 'strength']);
    expect(JSON.stringify(p)).not.toMatch(/similarity|percent|score|points|88/);
    expect(p.file).toMatchObject({ format: 'csv', encoding: 'UTF-8', delimiter: 'semicolon', notes: ['Read as CSV: encoding UTF-8, delimiter semicolon.'] });
    expect(p.rows[0].merged_into).toBeNull();
  });

  it('uploads the file bytes (not trusted for type) with a percent-encoded X-File-Name; multipart is not used by components', async () => {
    const calls = stub(() => ({ body: { ok: true, item: wirePlan } }));
    const ds = new ApiDataSource();
    const plan = await ds.inspectAccountsImport(new File(['Account name\nÅ Co\n'], 'q4 é.csv', { type: 'text/csv' }));
    expect(plan.import_id).toBe('b6f1');
    expect(calls[0].url).toBe('/api/import/accounts/inspect');
    expect(calls[0].init?.method).toBe('POST');
    const h = calls[0].init!.headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(decodeURIComponent(h['X-File-Name'])).toBe('q4 é.csv');
    expect(calls[0].init!.body).toBeInstanceOf(Uint8Array);
  });

  it('refuses a wrong extension and binary data locally without calling the server; the server repeats the checks', async () => {
    const calls = stub(() => ({ body: {} }));
    const ds = new ApiDataSource();
    await expect(ds.inspectAccountsImport(new File(['x'], 'a.txt'))).rejects.toMatchObject({ code: 'invalid_file', details: { reason: 'unsupported_type' } });
    await expect(ds.inspectAccountsImport(new File([new Uint8Array([0, 1, 2])], 'a.csv'))).rejects.toMatchObject({ code: 'invalid_file', details: { reason: 'not_csv' } });
    expect(calls).toHaveLength(0);
  });

  it('maps server errors with details (invalid_file reason, unresolved rows, stale, expired, 413)', async () => {
    const ds = new ApiDataSource();
    stub(() => ({ status: 422, body: { ok: false, error: { code: 'invalid_file', message: 'bad', details: { reason: 'too_many_rows', found: 812, limit: 500 } } } }));
    await expect(ds.inspectAccountsImport(new File(['Account name\nA\n'], 'a.csv'))).rejects.toMatchObject({ code: 'invalid_file', status: 422, details: { reason: 'too_many_rows', found: 812 } });
    stub(() => ({ status: 413, body: { ok: false, error: { code: 'payload_too_large', message: 'too big', details: { max_bytes: 5242880 } } } }));
    await expect(ds.inspectAccountsImport(new File(['Account name\nA\n'], 'a.csv'))).rejects.toMatchObject({ code: 'payload_too_large' });
    stub(() => ({ status: 409, body: { ok: false, error: { code: 'unresolved_duplicates', message: 'x', details: { rows: [4, 9] } } } }));
    const e = await ds.applyAccountsImport({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [] }).then(() => null, (x: unknown) => x as DataSourceError);
    expect(e).toBeInstanceOf(DataSourceError);
    expect(e?.details).toEqual({ rows: [4, 9] });
    stub(() => ({ status: 410, body: { ok: false, error: { code: 'import_expired', message: 'x' } } }));
    await expect(ds.getAccountsImport('i')).rejects.toMatchObject({ code: 'import_expired', status: 410 });
    stub(() => ({ status: 409, body: { ok: false, error: { code: 'preview_stale', message: 'x', details: { changed: [{ row: 4, reason: 'account changed' }] } } } }));
    await expect(ds.applyAccountsImport({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [] })).rejects.toMatchObject({ code: 'preview_stale' });
  });

  it('apply posts the decisions; check-similar posts name and bpid; client/save keeps duplicates_confirmed', async () => {
    const calls = stub((url) => {
      if (url.endsWith('/apply')) return { body: { ok: true, item: { import_id: 'i', counts: {}, skipped: [] } } };
      if (url.endsWith('/check-similar')) return { body: { ok: true, item: { exact: null, candidates: [wirePlan.rows[1].candidates[0]] } } };
      return { body: { ok: true, item: { id: 'n1', name: 'W', counts: { open_tasks: 0, overdue: 0, waiting: 0, active_alerts: 0, next_upgrade: null, upcoming_upgrades: 0, servers: 0 } }, side_effects: [] } };
    });
    const ds = new ApiDataSource();
    await ds.applyAccountsImport({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [{ row: 3, choice: 'same', target: { type: 'account', id: 'x' } }] });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [{ row: 3, choice: 'same', target: { type: 'account', id: 'x' } }] });
    const c = await ds.checkSimilarAccount({ name: 'Web Ltd', bpid: '1' });
    expect(calls[1].url).toBe('/api/client/check-similar');
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ name: 'Web Ltd', bpid: '1' });
    expect(c.candidates[0]).not.toHaveProperty('score');
    await ds.saveAccount({ name: 'W', bpid: null, products: null, status: 'Active', next_contact: null, notes: null, duplicates_confirmed: true });
    expect(JSON.parse(calls[2].init!.body as string).duplicates_confirmed).toBe(true);
  });

  it('downloads: template format and skipped-rows format go in the query; the filename comes from Content-Disposition', async () => {
    const calls = stub(() => ({ headers: { 'Content-Disposition': 'attachment; filename="tam_accounts_import_template.csv"' }, blob: new Blob(['h']) }));
    const ds = new ApiDataSource();
    const f = await ds.downloadImportTemplate('csv');
    expect(calls[0].url).toBe('/api/import/accounts/template?format=csv');
    expect(f.filename).toBe('tam_accounts_import_template.csv');
    await ds.downloadSkippedRows('i d', 'xlsx');
    expect(calls[1].url).toBe('/api/import/accounts/i%20d/skipped.xlsx'); // the file is in the upload's format (contract 10.5)
    await ds.downloadSkippedRows('i', 'csv');
    expect(calls[2].url).toBe('/api/import/accounts/i/skipped.csv');
  });
});

// ApiDataSource: portability routes (docs/04_API_CONTRACT.md section 14). Request shapes and error mapping only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiDataSource } from './ApiDataSource';
import { DataSourceError } from './DataSource';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
function stub(handler: (url: string) => Reply) {
  const calls: { url: string; method?: string; headers?: Record<string, string>; body?: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const r = handler(url);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: new Headers(r.headers), json: async () => r.body, blob: async () => new Blob(['x']) } as unknown as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const plan = { restore_id: 'r1', plan_hash: 'sha256:a', files: [{ file_id: 'f', name: 'A.csv', format: 'csv', size_bytes: 1, table: 'accounts', table_label: 'Accounts', table_source: 'headers', state: 'ready', rows: 1 }], tables: [], totals: {}, can_apply: true };

describe('portability adapter', () => {
  it('downloads both exports and takes the file name from Content-Disposition', async () => {
    const calls = stub(() => ({ body: {}, headers: { 'Content-Disposition': 'attachment; filename="tam_export_20261015-0900_DEV.xlsx"' } }));
    const f = await new ApiDataSource().exportExcel();
    await new ApiDataSource().exportDatabase();
    expect(calls.map((c) => c.url)).toEqual(['/api/export/excel', '/api/export/database']);
    expect(f.filename).toBe('tam_export_20261015-0900_DEV.xlsx');
  });
  it('uploads the raw file with X-File-Name, session and table query, and fills list defaults', async () => {
    const calls = stub(() => ({ body: { ok: true, item: plan } }));
    const p = await new ApiDataSource().inspectRestoreFile(new File(['id,name\n'], 'Accounts.csv'), { session: 'r1', table: 'accounts' });
    expect(calls[0].url).toBe('/api/restore/inspect?session=r1&table=accounts');
    expect(calls[0].headers).toMatchObject({ 'X-File-Name': 'Accounts.csv', 'Content-Type': 'application/octet-stream' });
    expect(p.files[0].missing_columns).toEqual([]);
    expect(p.issues).toEqual([]);
  });
  it('remove, table, plan paging and apply use the documented bodies', async () => {
    const calls = stub(() => ({ body: { ok: true, item: plan } }));
    const ds = new ApiDataSource();
    await ds.removeRestoreFile('r1', 'f');
    await ds.setRestoreTable('r1', 'f', 'contacts');
    await ds.getRestorePlan('r1', { table: 'accounts', outcome: 'invalid', limit: 50 });
    await ds.applyRestore({ restore_id: 'r1', plan_hash: 'sha256:a' });
    expect(calls.map((c) => c.url)).toEqual(['/api/restore/r1/remove', '/api/restore/r1/table', '/api/restore/r1?table=accounts&outcome=invalid&limit=50', '/api/restore/apply']);
    expect(calls[0].body).toEqual({ file_id: 'f' });
    expect(calls[1].body).toEqual({ file_id: 'f', table: 'contacts' });
    expect(calls[3].body).toEqual({ restore_id: 'r1', plan_hash: 'sha256:a', confirm: true });
  });
  it('database restore routes and the 501 stub map to a not_implemented error', async () => {
    const calls = stub(() => ({ status: 501, body: { ok: false, error: { code: 'not_implemented', message: 'Not implemented' } } }));
    const ds = new ApiDataSource();
    const e = await ds.previewBackupRestore('tam_x.db').catch((x) => x);
    expect(e).toBeInstanceOf(DataSourceError);
    expect(e).toMatchObject({ code: 'not_implemented', status: 501 });
    await ds.applyDatabaseRestore({ restore_id: 'r', confirm: 'RESTORE' }).catch(() => undefined);
    await ds.cancelDatabaseRestore('r').catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual(['/api/restore/database/from-backup', '/api/restore/database/apply', '/api/restore/database/r/cancel']);
    expect(calls[0].body).toEqual({ name: 'tam_x.db' });
    expect(calls[1].body).toEqual({ restore_id: 'r', confirm: 'RESTORE' });
  });
  it('refuses oversize files before sending them', async () => {
    const calls = stub(() => ({ body: {} }));
    const big = new File(['x'], 'big.db');
    Object.defineProperty(big, 'size', { value: 501 * 1_048_576 });
    const e = await new ApiDataSource().inspectDatabaseRestore(big).catch((x) => x);
    expect(e).toMatchObject({ code: 'payload_too_large' });
    expect(calls).toHaveLength(0);
  });
  it('logs download uses ?file=, reads X-Log-Files-Omitted; audit pages carry retention', async () => {
    const calls = stub((url) => (url.startsWith('/api/logs') ? { body: {}, headers: { 'Content-Disposition': 'attachment; filename="tam_logs_20261016.zip"', 'X-Log-Files-Omitted': '3' } } : { body: { ok: true, total: 0, limit: 50, offset: 0, has_more: false, items: [], retention: { retention_days: 14, interval_days: 14, last_pruned_at: null, next_due_at: '2026-10-30T00:00:00.000Z' } } }));
    const ds = new ApiDataSource();
    const f = await ds.downloadLogs('zip');
    await ds.downloadLogs('current');
    expect(calls.map((c) => c.url).slice(0, 2)).toEqual(['/api/logs/download?file=zip', '/api/logs/download?file=current']);
    expect(f).toMatchObject({ filename: 'tam_logs_20261016.zip', omitted: 3 });
    expect((await ds.getAudit({})).retention).toMatchObject({ retention_days: 14 });
  });
});

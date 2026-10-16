import { afterEach, expect, it, vi } from 'vitest';
import { ApiDataSource } from './ApiDataSource';

afterEach(() => vi.unstubAllGlobals());
it('getRuntime carries db_name from /api/health and tolerates its absence', async () => {
  const reply = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response));
  reply({ ok: true, mode: 'DEV', version: '1', schema_version: 1, db_path: '/x/tam_fresh.db', db_name: 'tam_fresh' });
  expect((await new ApiDataSource().getRuntime()).db_name).toBe('tam_fresh');
  reply({ ok: true, mode: 'DEV', version: '1', schema_version: 1, db_path: '/x/tam_dev.db' });
  expect((await new ApiDataSource().getRuntime()).db_name).toBeUndefined();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiDataSource, mapAccount, mapActivity, mapInfra, mapInfraSummary } from './ApiDataSource';
import { DataSourceError } from './DataSource';

// Payloads below are shaped exactly like the examples in docs/04_API_CONTRACT.md.
const wireAccount = {
  id: 'c1', name: 'Acme Capital', status: 'Active', bpid: '1234567', products: 'Terminal', notes: null, last_contact: '2026-10-02', next_contact: '2026-10-15',
  row_version: 3, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  counts: { open_tasks: 12, overdue: 3, waiting: 2, active_alerts: 1, next_upgrade: '2026-10-24', upcoming_upgrades: 2, servers: 5 },
};
const wireInfra = {
  client_id: 'c1', servers: 5, active_alerts: 1, next_upgrade: { date: '2026-10-24', server: 'bxa-ny-01' },
  environment_summary: { PROD: 4, DEV: 1, unknown: 0, regions: ['East', 'West'] },
  bams_objects: [{ id: 'o1', client_id: 'c1', name: 'bxa-ny-01', region: 'East', location: 'NY', environment: 'PROD', enabled: true, row_version: 1, worst_status: 'Stale', metric_count: 4, alerts: [{ id: 'a', status: 'open' }] }],
  server_upgrades: [
    { id: 'u1', client_id: 'c1', server_name: 'bxa-ny-01', environment: 'PROD', polarity: 'East', schedule_year: 2026, schedule_quarter: 'Q4', current_version: '7.1.4', target_version: '7.2.0', scheduled_date: '2026-10-24', maintenance_window: null, status: 'Scheduled', validation_status: 'Pending', waiting_on: null, reference: null, notes: null, row_version: 1, updated_at: 'x' },
    { id: 'u2', client_id: 'c1', server_name: 'old-01', environment: 'DEV', polarity: 'DEV', schedule_year: null, schedule_quarter: null, current_version: null, target_version: null, scheduled_date: '2026-09-01', maintenance_window: null, status: 'Completed', validation_status: 'Passed', waiting_on: null, reference: null, notes: null, row_version: 1, updated_at: 'x' },
  ],
};

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('ApiDataSource mapping (docs/04_API_CONTRACT.md)', () => {
  it('flattens account counts into AccountSummary', () => {
    const a = mapAccount(wireAccount as never);
    expect(a.open_tasks).toBe(12);
    expect(a.next_upgrade).toBe('2026-10-24');
    expect(a).not.toHaveProperty('counts');
  });

  it('builds the infrastructure summary (env string, regions, next upgrade ignoring Completed)', () => {
    const s = mapInfraSummary(wireInfra as never);
    expect(s.env_summary).toBe('PROD 4 · DEV 1');
    expect(s.regions).toEqual(['East', 'West']);
    expect(s.next_upgrade).toEqual({ date: '2026-10-24', server: 'bxa-ny-01' });
    const i = mapInfra(wireInfra as never);
    expect(i.bams_objects[0].active_alerts).toBe(1);
    expect(i.upgrades).toHaveLength(2);
  });

  it('maps kind-tagged activity entries (notes get a Note; BAMS and upgrade events get a server link target)', () => {
    const note = mapActivity({ kind: 'note', entry_key: 'n:1', ts: '2026-10-11T10:00:00.000Z', id: '1', client_id: 'c1', created_at: '2026-10-11T09:59:00.000Z', note_type: 'Call Note', subject: 'S', body: null, action_items: null, source: 'GUI', row_version: 2, updated_at: 'u' });
    expect(note.entry_kind === 'note' && note.note.client_id).toBe('c1');
    expect(note.entry_kind === 'note' && note.note.created_at).toBe('2026-10-11T09:59:00.000Z');
    const bams = mapActivity({ kind: 'system', entry_key: 'b:e:opened', ts: 't', event_type: 'bams_alert.opened', object_type: 'bams_alert_event', object_id: 'e', label: 'bxa-ny-01 · CPU', server_name: 'bxa-ny-01', severity: 'Critical', source: 'System', sentence: 'BAMS alert opened: bxa-ny-01 · CPU (Critical)' });
    expect(bams.entry_kind === 'system' && bams.server_name).toBe('bxa-ny-01');
    const up = mapActivity({ kind: 'system', entry_key: 'a:1', ts: 't', event_type: 'server_upgrade.created', object_type: 'server_upgrade', object_id: 'u', label: 'srv-02', server_name: 'srv-02', severity: null, source: 'GUI', sentence: 'Server upgrade scheduled: srv-02' });
    expect(up.entry_kind === 'system' && up.server_name).toBe('srv-02');
    const task = mapActivity({ kind: 'system', entry_key: 'a:2', ts: 't', event_type: 'task.completed', object_type: 'task', object_id: 't', label: 'x', server_name: null, severity: null, source: 'GUI', sentence: 'Task completed: x' });
    expect(task.entry_kind === 'system' && task.server_name).toBeNull();
  });
});

describe('ApiDataSource requests', () => {
  it('getState flattens accounts and exposes runtime as api', async () => {
    mockFetch(() => ({ body: { ok: true, today: '2026-10-12', runtime: { mode: 'DEV', version: '0.1.0-dev', schema_version: 1, db_path: 'x' }, settings: { default_landing: 'today' }, accounts: [wireAccount], tasks: [{ id: 't', archived: 0 }], contacts: [{ id: 'k', is_primary: 1 }], infrastructure: { c1: wireInfra } } }));
    const s = await new ApiDataSource().getState();
    expect(s.accounts[0].overdue).toBe(3);
    expect(s.tasks[0].archived).toBe(false);
    expect(s.contacts[0].is_primary).toBe(true);
    expect(s.runtime.source).toBe('api');
    expect(s.infrastructure.c1.servers).toBe(5);
  });

  it('getNote uses GET /api/note/{id} (FE-AC-1) and maps 404 not_found to null', async () => {
    const calls = mockFetch((url) => (url.endsWith('/n1') ? { body: { ok: true, item: { id: 'n1', client_id: 'c1' } } } : { status: 404, body: { ok: false, error: { code: 'not_found', message: 'Note not found.' } } }));
    const ds = new ApiDataSource();
    expect((await ds.getNote('n1'))?.client_id).toBe('c1');
    expect(calls[0].url).toBe('/api/note/n1');
    expect(await ds.getNote('zz')).toBeNull();
  });

  it('wraps settings in {settings} and sends expected_row_version on task saves', async () => {
    const calls = mockFetch((url) => (url.includes('settings') ? { body: { ok: true, item: { time_display: 'gmt' }, side_effects: [] } } : { body: { ok: true, item: { id: 't', archived: false }, side_effects: [{ type: 'next_contact_updated' }] } }));
    const ds = new ApiDataSource();
    await ds.saveSettings({ time_display: 'gmt' });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ settings: { time_display: 'gmt' } });
    const r = await ds.saveTask({ id: 't', task: 'x', client_id: null, category: 'Other', priority: 'Low', due: null, next_update: null, status: 'Complete', waiting: null, notes: null, expected_row_version: 4 });
    expect(JSON.parse(calls[1].init!.body as string).expected_row_version).toBe(4);
    expect(calls[1].url).toBe('/api/task/save');
    expect(r.side_effects).toEqual(['next_contact_updated']);
  });

  it('builds the primary-contact message from the primary_cleared side effect and omits client_id on update', async () => {
    const calls = mockFetch(() => ({ body: { ok: true, item: { id: 'b', name: 'Bea', is_primary: true }, side_effects: [{ type: 'primary_cleared', contact_id: 'a', name: 'Al' }] } }));
    const r = await new ApiDataSource().saveContact({ id: 'b', client_id: 'c1', name: 'Bea', role: null, team: null, email: null, is_primary: true, expected_row_version: 1 });
    expect(r.message).toBe('Bea is now primary (was Al)');
    expect(JSON.parse(calls[0].init!.body as string)).not.toHaveProperty('client_id');
  });

  it('maps API errors to DataSourceError with code and fields', async () => {
    mockFetch(() => ({ status: 422, body: { ok: false, error: { code: 'validation_error', message: 'Request validation failed.', fields: { due: 'must be a date' } } } }));
    await expect(new ApiDataSource().saveTask({} as never)).rejects.toMatchObject({ code: 'validation_error', fields: { due: 'must be a date' }, status: 422 });
    mockFetch(() => ({ status: 409, body: { ok: false, error: { code: 'stale_write', message: 'changed', details: { current_row_version: 9 } } } }));
    const e = await new ApiDataSource().saveTask({} as never).catch((x) => x);
    expect(e).toBeInstanceOf(DataSourceError);
    expect(e.code).toBe('stale_write');
  });

  it('reports network failures as code "network"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    await expect(new ApiDataSource().getToday()).rejects.toMatchObject({ code: 'network' });
  });

  it('getTasks sends archived as a string and getActivity forwards the cursor as `before`', async () => {
    const calls = mockFetch((url) => (url.includes('/activity') ? { body: { ok: true, items: [], next_cursor: null } } : { body: { ok: true, items: [] } }));
    const ds = new ApiDataSource();
    await ds.getTasks({ client_id: 'c1', archived: true });
    expect(calls[0].url).toBe('/api/tasks?client_id=c1&archived=true');
    await ds.getActivity('c1', { filter: 'call', q: 'x y', cursor: 'abc', limit: 50 });
    expect(calls[1].url).toBe('/api/client/c1/activity?filter=call&q=x+y&before=abc&limit=50');
  });
});

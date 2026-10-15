// Mock Operations adapter parity with docs/04_API_CONTRACT.md section 13.
import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../DataSource';
import { newMock } from './testFile';

async function err(p: Promise<unknown>): Promise<DataSourceError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(DataSourceError); return e as DataSourceError; }
  throw new Error('expected DataSourceError');
}
const Q = { year: 2031, quarter: 'Q2' as const };

describe('mock operations', () => {
  it('lists every appliance once, grouped by account with summaries that match the rows', async () => {
    const ds = newMock();
    const d = await ds.getOperations({});
    expect(d.appliance_total).toBe(d.groups.reduce((n, g) => n + g.rows.length, 0));
    for (const g of d.groups) { expect(g.count).toBe(g.rows.length); expect(g.summary.total).toBe(g.rows.length); }
    expect(d.groups.map((g) => g.client_name)).toEqual([...d.groups.map((g) => g.client_name)].sort((a, b) => a.localeCompare(b)));
    expect(d.summary.total).toBe(d.appliance_total);
  });
  it('quarter create, duplicate, version applies to all appliances, edit with row_version, stale, delete', async () => {
    const ds = newMock();
    const q = await ds.saveOperationsQuarter({ ...Q, apics_version: '9.9.9', dev_upgrade_date: '2031-04-01', east_prod_date: '2031-04-08', west_prod_date: null });
    expect(q).toMatchObject({ label: '2031 Q2', target_version: '9.9.9', row_version: 1 });
    expect((await err(ds.saveOperationsQuarter({ ...Q, apics_version: null, dev_upgrade_date: null, east_prod_date: null, west_prod_date: null }))).message).toBe('2031 Q2 already exists. Edit it instead.');
    const d = await ds.getOperations(Q);
    expect(d.groups.flatMap((g) => g.rows).every((r) => r.version.effective === '9.9.9' && r.version.source === 'quarter')).toBe(true);
    const q2 = await ds.saveOperationsQuarter({ ...Q, apics_version: '9.9.10', dev_upgrade_date: null, east_prod_date: null, west_prod_date: null, expected_row_version: 1 });
    expect(q2.row_version).toBe(2);
    expect((await err(ds.saveOperationsQuarter({ ...Q, apics_version: null, dev_upgrade_date: null, east_prod_date: null, west_prod_date: null, expected_row_version: 1 }))).code).toBe('stale_write');
    expect((await err(ds.deleteOperationsQuarter({ ...Q, confirm: false }))).code).toBe('confirmation_required');
    await ds.deleteOperationsQuarter({ ...Q, confirm: true });
    expect((await ds.getOperations({})).quarters.some((x) => x.label === '2031 Q2')).toBe(false);
  });
  it('set version: own version wins, blank clears to the quarter default, PROD without polarity is skipped and named, nothing else changes', async () => {
    const ds = newMock();
    await ds.saveOperationsQuarter({ ...Q, apics_version: '1.0.0', dev_upgrade_date: '2031-04-01', east_prod_date: '2031-04-08', west_prod_date: '2031-04-15' });
    const rows = (await ds.getOperations(Q)).groups.flatMap((g) => g.rows);
    const ok = rows.filter((r) => r.can_record).slice(0, 2);
    const bad = rows.find((r) => !r.can_record);
    const ids = [...ok.map((r) => r.object_id), ...(bad ? [bad.object_id] : [])];
    const r = await ds.setOperationsVersion({ ...Q, object_ids: ids, target_version: '5.0.1' });
    expect(r.updated).toHaveLength(ok.length);
    if (bad) { expect(r.skipped.map((s) => s.object_id)).toEqual([bad.object_id]); expect(r.message).toMatch(/skipped: set (east or west|environment)/i); }
    const after = (await ds.getOperations(Q)).groups.flatMap((g) => g.rows);
    for (const o of ok) {
      const a = after.find((x) => x.object_id === o.object_id)!;
      expect(a.version).toMatchObject({ effective: '5.0.1', source: 'appliance', quarter_default: '1.0.0' });
      expect(a.status).toBe('Planned'); expect(a.date.source).toBe(o.date.source);
    }
    await ds.setOperationsVersion({ ...Q, object_ids: ok.map((r) => r.object_id), target_version: null });
    const cleared = (await ds.getOperations(Q)).groups.flatMap((g) => g.rows).find((x) => x.object_id === ok[0].object_id)!;
    expect(cleared.version.source).toBe('quarter');
    expect((await err(ds.setOperationsVersion({ ...Q, object_ids: [], target_version: 'x' }))).code).toBe('validation_error');
  });
  it('appliance save creates the record on first change, status and override persist, reset needs confirm', async () => {
    const ds = newMock();
    await ds.saveOperationsQuarter({ ...Q, apics_version: null, dev_upgrade_date: '2031-04-01', east_prod_date: '2031-04-08', west_prod_date: '2031-04-15' });
    const r0 = (await ds.getOperations(Q)).groups.flatMap((g) => g.rows).find((r) => r.can_record)!;
    expect(r0).toMatchObject({ status: 'Planned', status_is_default: true, record_id: null });
    const r1 = await ds.saveOperationsAppliance({ object_id: r0.object_id, ...Q, status: 'Scheduled', date_override: '2031-05-05' });
    expect(r1).toMatchObject({ status: 'Scheduled', status_is_default: false, date: { effective: '2031-05-05', source: 'override' } });
    expect((await err(ds.saveOperationsAppliance({ object_id: r0.object_id, ...Q, status: 'Completed', expected_row_version: 99 }))).code).toBe('stale_write');
    expect((await err(ds.deleteOperationsQuarter({ ...Q, confirm: true }))).message).toBe('1 appliances have a status in this quarter');
    expect((await err(ds.resetOperationsAppliance({ object_id: r0.object_id, ...Q, confirm: false }))).code).toBe('confirmation_required');
    const r2 = await ds.resetOperationsAppliance({ object_id: r0.object_id, ...Q, confirm: true });
    expect(r2).toMatchObject({ status: 'Planned', record_id: null });
  });
  it('filters combine and the search matches account or appliance', async () => {
    const ds = newMock();
    const all = await ds.getOperations({});
    const name = all.groups[0].rows[0].appliance;
    const hit = await ds.getOperations({ q: name.toLowerCase() });
    expect(hit.groups.flatMap((g) => g.rows).every((r) => r.appliance.toLowerCase().includes(name.toLowerCase()) || r.client_name.toLowerCase().includes(name.toLowerCase()))).toBe(true);
    const none = await ds.getOperations({ q: 'zzz-no-such' });
    expect(none.summary.total).toBe(0); expect(none.appliance_total).toBe(all.appliance_total);
  });
});

describe('import note (contract 13.7)', () => {
  it('counts appliances without East/West or Environment and is informational', async () => {
    const ds = newMock();
    const acct = (await ds.getOperations({})).groups[0].client_name;
    const head = 'Account,BPID,Appliance,Metric,Ticker,Region,Location,Environment,Enabled,Stale after (s)';
    const f = new File([`${head}\n${acct},,OPS-NEW-1,CPU,OPS1 Index,East,,PROD,yes,120\n${acct},,OPS-NEW-2,CPU,OPS2 Index,Emea,,PROD,yes,120\n${acct},,OPS-NEW-3,CPU,OPS3 Index,West,,,yes,120\n`], 'i.csv', { type: 'text/csv' });
    const plan = await ds.inspectBamsImport(f);
    expect(plan.operations_note).toEqual({ count: 2, text: '2 appliances need East or West set for Operations' });
  });
});

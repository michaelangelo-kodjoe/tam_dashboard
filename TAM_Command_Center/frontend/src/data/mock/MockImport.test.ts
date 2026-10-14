// The mock adapter's import flow (docs/01_PM_SPEC.md D-39..D-48) and the shared check-similar engine (D-45).
import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../DataSource';
import { newMock } from './testFile';
import { readBytes } from '../importFile';
import type { ImportDecision, ImportPlan } from '../../types';

const H = 'Account name,BPID,Products,Status,Next contact date,Notes\n';
const file = (text: string, name = 'accounts.csv') => new File([text], name, { type: 'text/csv' });
async function code(p: Promise<unknown>): Promise<DataSourceError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(DataSourceError); return e as DataSourceError; }
  throw new Error('expected DataSourceError');
}
const flagged = (p: ImportPlan) => p.rows.filter((r) => r.state === 'needs_review');
const apply = (ds: ReturnType<typeof newMock>, p: ImportPlan, decisions: ImportDecision[]) => ds.applyAccountsImport({ import_id: p.import_id, plan_hash: p.plan_hash, confirm: true, decisions });

const SAMPLE =
  H +
  'Ashgrove Capital Partners,210551,"Terminal, B-PIPE",Active,2026-11-02,\n' + // 2 new
  'castellan  peak GLOBAL markets,,,,,Renewal chat\n' + // 3 exact (case/space), notes blank on existing? see assertions
  'Halvorsen Fjord Asset Mgmt,,,,,Oslo\n' + // 4 flagged High (abbreviation)
  'Quillfeather Advisory,,Terminal,Active,2026-11-03,\n' + // 5 new
  'Quillfeather Advisory Group,,,,,Alt entity?\n' + // 6 flagged vs row 5
  'Linden Row Pensions,330918,,Dormant,,\n' + // 7 invalid
  ',552210,,,,\n'; // 8 invalid (name required)

describe('inspect', () => {
  it('counts, states and the golden candidates; Inspect writes nothing', async () => {
    const ds = newMock();
    const before = (await ds.getState()).accounts.length;
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    expect(p.counts).toMatchObject({ rows: 7, valid: 5, new: 2, updates: 1, needs_review: 2, invalid: 2 });
    expect(p.counts.valid + p.counts.invalid).toBe(p.counts.rows);
    expect(p.file).toMatchObject({ format: 'csv', encoding: 'UTF-8', delimiter: 'comma', sheet: 'CSV', rows_found: 7, notes: ['Read as CSV: encoding UTF-8, delimiter comma.'] });
    const h = p.rows.find((r) => r.row === 4)!;
    expect(h.candidates[0]).toMatchObject({ name: 'Halvorsen Fjord Asset Management', strength: 'High', ref: { type: 'account' } });
    expect(h.candidates[0].reasons.map((r) => r.code)).toEqual(['same_words_spelled_differently', 'abbreviation']);
    const g = p.rows.find((r) => r.row === 6)!;
    expect(g.candidates[0]).toMatchObject({ ref: { type: 'row', row: 5 }, strength: 'High' });
    expect(p.rows.find((r) => r.row === 7)!.errors[0].text).toMatch(/Dormant/);
    expect(p.rows.find((r) => r.row === 8)!.errors[0].text).toMatch(/Account name is required/);
    expect((await ds.getState()).accounts).toHaveLength(before);
    expect(JSON.stringify(p)).not.toMatch(/"(score|similarity|percent)"|\d\s?%/i);
  });
  it('refusals carry details.reason and never create a session', async () => {
    const ds = newMock();
    const e = await code(ds.inspectAccountsImport(new File([new Uint8Array([1, 0, 2, 0])], 'x.csv')));
    expect(e.code).toBe('invalid_file');
    expect(e.details?.reason).toBe('not_csv');
    const big = H + Array.from({ length: 501 }, (_, i) => `A${i},,,,,`).join('\n');
    const e2 = await code(ds.inspectAccountsImport(file(big)));
    expect(e2.details).toMatchObject({ reason: 'too_many_rows', found: 501, limit: 500 });
    expect((await code(ds.getAccountsImport('nope'))).code).toBe('import_expired');
  });
  it('at most three sessions live; the oldest is discarded', async () => {
    const ds = newMock();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await ds.inspectAccountsImport(file(`${H}Zed ${i},,,,,\n`))).import_id);
    expect((await code(ds.getAccountsImport(ids[0]))).code).toBe('import_expired');
    expect((await ds.getAccountsImport(ids[3])).import_id).toBe(ids[3]);
  });
});

describe('apply (D-43, D-44)', () => {
  it('unresolved flagged rows -> 409 unresolved_duplicates with the rows; nothing written, no backup', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    const e = await code(apply(ds, p, [{ row: 4, choice: 'skip' }]));
    expect(e.code).toBe('unresolved_duplicates');
    expect(e.details?.rows).toEqual([6]);
    expect((await ds.listBackups()).some((b) => b.reason === 'pre-import')).toBe(false);
    expect((await ds.getState()).accounts.some((a) => a.name === 'Ashgrove Capital Partners')).toBe(false);
  });
  it('decision validation: Same needs a target among the candidates; none on Different; unknown rows; Same onto a skipped row', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    const acct = flagged(p)[0].candidates[0].ref;
    expect((await code(apply(ds, p, [{ row: 4, choice: 'same' }, { row: 6, choice: 'skip' }]))).code).toBe('validation_error');
    expect((await code(apply(ds, p, [{ row: 4, choice: 'different', target: acct }, { row: 6, choice: 'skip' }]))).code).toBe('validation_error');
    expect((await code(apply(ds, p, [{ row: 4, choice: 'skip' }, { row: 6, choice: 'skip' }, { row: 2, choice: 'skip' }]))).code).toBe('validation_error');
    const e = await code(apply(ds, p, [{ row: 4, choice: 'skip' }, { row: 6, choice: 'same', target: { type: 'row', row: 5 } }, { row: 5, choice: 'skip' }]));
    expect(e.code).toBe('validation_error'); // row 5 is not flagged, so a decision on it is refused (and Same onto a skipped row is never valid)
  });
  it('writes creates and fills only blanks; Same merges; Different creates; Skip is listed; audit is Bulk Import', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE, 'q4.csv'));
    const hal = p.rows.find((r) => r.row === 4)!.candidates[0];
    const verBefore = (await ds.getState()).accounts.find((a) => a.name === 'Halvorsen Fjord Asset Management')!.row_version;
    const r = await apply(ds, p, [{ row: 4, choice: 'same', target: hal.ref }, { row: 6, choice: 'same', target: { type: 'row', row: 5 } }]);
    expect(r.counts).toMatchObject({ created: 2, skipped: 2, invalid: 2, overwritten: 0 });
    expect(r.backup?.reason).toBe('pre-import');
    expect(r.audit_events).toBe(r.created.length + r.updated.length);
    const s = await ds.getState();
    const pine = s.accounts.find((a) => a.name === 'Quillfeather Advisory')!;
    expect(pine.notes).toBe('Alt entity?'); // later row filled the blank notes of the earlier row
    expect(s.accounts.some((a) => a.name === 'Quillfeather Advisory Group')).toBe(false);
    const hfa = s.accounts.find((a) => a.name === 'Halvorsen Fjord Asset Management')!;
    expect(hfa.products).toBe('B-PIPE, Server API'); // existing value untouched
    expect(hfa.notes).not.toBe('Oslo'); // existing non-blank Notes win (D-43)
    expect(hfa.row_version).toBe(verBefore); // nothing to fill: no write, no version bump
    expect(r.counts.unchanged).toBeGreaterThanOrEqual(1);
    const state = ds as unknown as { t: { audit_events: { source: string; reason: string; action: string }[] } };
    const audits = state.t.audit_events.filter((a) => a.source === 'Bulk Import');
    expect(audits).toHaveLength(r.audit_events);
    expect(audits.every((a) => /^Bulk import: q4\.csv, rows? \d/.test(a.reason))).toBe(true);
    expect(r.skipped.map((x) => [x.row, x.kind])).toEqual([[7, 'invalid'], [8, 'invalid']]);
  });
  it('an exact match fills blank fields, bumps row_version once and writes one audit row', async () => {
    const ds = newMock();
    const made = await ds.saveAccount({ name: 'Blank Fill Co', bpid: null, products: null, status: 'Active', next_contact: null, notes: null });
    const p = await ds.inspectAccountsImport(file(`${H}blank fill co,555,Terminal,Inactive,2026-12-01,a note\n`));
    expect(p.rows[0].match?.fills).toEqual({ bpid: '555', products: 'Terminal', next_contact: '2026-12-01', notes: 'a note' });
    const r = await apply(ds, p, []);
    expect(r.counts).toMatchObject({ created: 0, updated: 1, unchanged: 0, overwritten: 0 });
    expect(r.fields_filled).toBe(4);
    const a = (await ds.getState()).accounts.find((x) => x.id === made.item.id)!;
    expect(a).toMatchObject({ bpid: '555', products: 'Terminal', notes: 'a note', status: 'Active', row_version: made.item.row_version + 1 });
  });
  it('Different account creates a new account with the file values; Skip records "Skipped by you"', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    const r = await apply(ds, p, [{ row: 4, choice: 'skip' }, { row: 6, choice: 'different' }]);
    expect(r.counts.created).toBe(3);
    expect(r.skipped.find((x) => x.row === 4)).toMatchObject({ kind: 'by_user', reason: 'Skipped by you (possible duplicate of Halvorsen Fjord Asset Management)' });
    expect((await ds.getState()).accounts.some((a) => a.name === 'Quillfeather Advisory Group')).toBe(true);
  });
  it('Inactive stays Inactive and an existing non-blank value is never overwritten, whatever the file says', async () => {
    const ds = newMock();
    const text = H + 'Aurelian Vale Commodities,999,Other,Active,2030-01-01,new note\nPinecrest Shoal Municipal Fund,,,Active,,\n';
    const p = await ds.inspectAccountsImport(file(text));
    expect(p.rows[0].match?.notes).toEqual(['Existing account is Inactive and stays Inactive']);
    expect(p.rows[0].match?.kept.bpid).toMatchObject({ file: '999' });
    const before = (await ds.getState()).accounts.find((a) => a.name === 'Aurelian Vale Commodities')!;
    await apply(ds, p, []);
    const after = (await ds.getState()).accounts.find((a) => a.name === 'Aurelian Vale Commodities')!;
    expect(after.status).toBe('Inactive');
    expect(after.bpid).toBe(before.bpid);
    expect(after.products).toBe(before.products);
    expect(after.next_contact).toBe(before.next_contact);
  });
  it('a changed account since Preview -> 409 preview_stale; the refreshed plan keeps unchanged rows', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    const hal = (await ds.getState()).accounts.find((a) => a.name === 'Halvorsen Fjord Asset Management')!;
    await ds.saveAccount({ id: hal.id, name: hal.name, bpid: hal.bpid, products: hal.products, status: hal.status, next_contact: hal.next_contact, notes: 'edited elsewhere' });
    const cand = p.rows.find((r) => r.row === 4)!.candidates[0].ref;
    const e = await code(apply(ds, p, [{ row: 4, choice: 'same', target: cand }, { row: 6, choice: 'different' }]));
    expect(e.code).toBe('preview_stale');
    const fresh = await ds.getAccountsImport(p.import_id);
    expect(fresh.plan_hash).not.toBe(p.plan_hash);
    expect((await ds.getState()).accounts.some((a) => a.name === 'Ashgrove Capital Partners')).toBe(false);
  });
  it('a second Apply returns already_applied with the stored result; re-importing the same file creates and updates nothing', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(SAMPLE));
    const first = await apply(ds, p, [{ row: 4, choice: 'skip' }, { row: 6, choice: 'skip' }]);
    const e = await code(apply(ds, p, []));
    expect(e.code).toBe('already_applied');
    expect((e.details?.result as { import_id: string }).import_id).toBe(first.import_id);
    const again = await ds.inspectAccountsImport(file(SAMPLE));
    const flaggedAgain = flagged(again).map((r) => ({ row: r.row, choice: 'skip' as const }));
    const r2 = await apply(ds, again, flaggedAgain);
    expect(r2.counts.created).toBe(0);
    expect(r2.counts.updated).toBe(0);
    expect(r2.backup).toBeNull(); // nothing changed: no backup, no audit
    expect(r2.audit_events).toBe(0);
  });
});

describe('skipped rows download', () => {
  it('is offered in the format of the upload, neutralises = + - @ in csv, and writes text only in xlsx', async () => {
    const ds = newMock();
    const text = H + '=EVIL(),1,,Dormant,,"+1 call"\nOk Co,,,,,\n';
    const p = await ds.inspectAccountsImport(file(text));
    await apply(ds, p, []);
    const csv = await ds.downloadSkippedRows(p.import_id, 'csv');
    expect(csv.filename).toMatch(/\.csv$/);
    const t = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await readBytes(csv.blob));
    expect(t.split(/\r?\n/)[0]).toBe('﻿Account name,BPID,Products,Status,Next contact date,Notes,Source row,Reason,Possible duplicate of');
    expect(t).toContain("'=EVIL()");
    expect(t).toContain("'+1 call");
    expect(t).not.toMatch(/(^|,)=EVIL/);
    expect((await code(ds.downloadSkippedRows(p.import_id, 'xlsx'))).code).toBe('not_found'); // only the upload's format
    expect((await code(newMock().downloadSkippedRows('missing', 'csv'))).code).toBe('import_expired');
  });
  it('is refused before the import was applied; both templates are offered', async () => {
    const ds = newMock();
    const p = await ds.inspectAccountsImport(file(H + 'X Co,,,,,\n'));
    expect((await code(ds.downloadSkippedRows(p.import_id, 'csv'))).code).toBe('conflict');
    const c = await ds.downloadImportTemplate('csv');
    expect(c.filename).toBe('tam_accounts_import_template.csv');
    expect(new TextDecoder().decode(await readBytes(c.blob)).split(/\r?\n/).filter(Boolean)).toHaveLength(2); // header + one example row
    expect((await ds.downloadImportTemplate('xlsx')).filename).toBe('tam_accounts_import_template.xlsx');
  });
});

describe('check-similar and the Add account rule (D-45)', () => {
  it('returns the exact match and the same candidates as the import for the same name and BPID', async () => {
    const ds = newMock();
    const c = await ds.checkSimilarAccount({ name: 'Halvorsen Fjord Asset Mgmt', bpid: null });
    const p = await ds.inspectAccountsImport(file(H + 'Halvorsen Fjord Asset Mgmt,,,,,\n'));
    const viaImport = p.rows[0].candidates.map(({ ref, name, strength, reasons, differences }) => ({ ref, name, strength, reasons, differences }));
    expect(c.candidates.map(({ ref, name, strength, reasons, differences }) => ({ ref, name, strength, reasons, differences }))).toEqual(viaImport);
    const ex = await ds.checkSimilarAccount({ name: '  CASTELLAN peak global   markets ', bpid: null });
    expect(ex.exact?.name).toBe('Castellan Peak Global Markets');
    expect((await ds.checkSimilarAccount({ name: 'Totally Unrelated Name', bpid: null })).candidates).toEqual([]);
  });
  it('a create with candidates and no duplicates_confirmed -> 409 possible_duplicate; confirmed creates; exact stays conflict', async () => {
    const ds = newMock();
    const input = { name: 'Halvorsen Fjord Asset Mgmt', bpid: null, products: null, status: 'Active' as const, next_contact: null, notes: null };
    const e = await code(ds.saveAccount(input));
    expect(e.code).toBe('possible_duplicate');
    expect((e.details?.candidates as unknown[]).length).toBeGreaterThan(0);
    const n = (await ds.getState()).accounts.length;
    expect((await ds.getState()).accounts).toHaveLength(n);
    const ok = await ds.saveAccount({ ...input, duplicates_confirmed: true });
    expect(ok.item.name).toBe('Halvorsen Fjord Asset Mgmt');
    expect((await code(ds.saveAccount({ ...input, name: 'castellan peak global markets', duplicates_confirmed: true }))).code).toBe('conflict');
    expect((await ds.saveAccount({ ...input, name: 'Zzyzx Unique Holdings' })).item.id).toBeTruthy();
  });
});

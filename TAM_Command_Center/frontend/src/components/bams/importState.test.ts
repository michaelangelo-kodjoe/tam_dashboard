import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../../data/DataSource';
import type { BamsCandidate, BamsImportPlan, BamsImportRow, BamsReviewGroup } from '../../bamsTypes';
import { canApply, carryDecisions, choose, filterCount, groupRows, isResolved, mapBamsError, openBamsPath, resolvedCount, toRequest, unresolvedKeys } from './importState';

const cand = (over: Partial<BamsCandidate> = {}): BamsCandidate => ({
  ref: { type: 'appliance', id: 'a1' }, name: 'BPIPE-EU-1', region: 'Europe', location: null, environment: 'PROD', metric_count: 4, metrics: ['CPU'], strength: 'High',
  reasons: [{ code: 'x', text: 'Same name apart from a zero' }], differences: [], fills: { location: 'London' }, kept: {}, metrics_added: ['Throughput'], metrics_existing: ['CPU'], metrics_conflicts: [], notes: [], ...over,
});
const grp = (key: string, candidates: BamsCandidate[]): BamsReviewGroup => ({ key, client_id: 'c1', client_name: 'Halvorsen', rows: [11], file: { appliance: 'BPIPE-EU-01', region: null, location: null, environment: null, metrics: ['CPU'] }, strength: 'High', candidates });
const row = (n: number, state: BamsImportRow['state'], over: Partial<BamsImportRow> = {}): BamsImportRow => ({
  row: n, state, values: { account: 'Halvorsen', bpid: null, appliance: `APP-${n}`, metric: 'CPU', ticker: `T${n}`, region: null, location: null, environment: 'PROD', enabled: true, stale_after_seconds: 120 },
  raw: null, target: { client_id: 'c1', client_name: 'Halvorsen', appliance: { id: null, name: `APP-${n}`, is_new: true }, metric: { id: null, is_new: true } }, group: `g${n}`, review_key: null, fills: {}, kept: {}, errors: [], warnings: [], notes: [], ...over,
});
const plan = (review: BamsReviewGroup[], rows: BamsImportRow[] = []): BamsImportPlan => ({
  import_id: 'i', plan_hash: 'h', expires_at: '', file: { name: 'f.xlsx', size_bytes: 1, format: 'xlsx', sheet: 'Import', rows_found: rows.length, encoding: null, delimiter: null, notes: [] },
  limits: { max_rows: 500, max_candidates: 5, max_bytes: 1 }, counts: { rows: rows.length, valid: rows.filter((r) => r.state !== 'invalid').length, new: rows.filter((r) => r.state === 'new').length, updates: 0, unchanged: 0, needs_review: rows.filter((r) => r.state === 'needs_review').length, invalid: rows.filter((r) => r.state === 'invalid').length },
  appliances: { new: 0, updated: 0, unchanged: 0, needs_review: review.length }, metrics: { new: 0, updated: 0, unchanged: 0 }, warnings: [], review, rows,
});

describe('decisions: none preselected, Apply gated per flagged appliance (D-67, D-68)', () => {
  const g1 = grp('g11', [cand()]);
  const g2 = grp('g14', [cand({ ref: { type: 'group', key: 'g11' }, name: 'BPIPE-EU-01' })]);
  const p = plan([g1, g2], [row(11, 'needs_review'), row(14, 'needs_review'), row(2, 'new')]);

  it('starts with nothing decided and Apply locked', () => {
    expect(unresolvedKeys(p, {})).toEqual(['g11', 'g14']);
    expect(canApply(p, {})).toBe(false);
  });
  it('Same targets the compared candidate; Different and Skip carry no target', () => {
    let d = choose({}, g1, 'same', g1.candidates[0].ref);
    expect(d.g11).toEqual({ choice: 'same', target: { type: 'appliance', id: 'a1' } });
    d = choose(d, g1, 'different', g1.candidates[0].ref);
    expect(d.g11).toEqual({ choice: 'different' });
    expect(resolvedCount(p, d)).toBe(1);
    expect(canApply(p, d)).toBe(false);
    d = choose(d, g2, 'skip', g2.candidates[0].ref);
    expect(canApply(p, d)).toBe(true);
  });
  it('Same onto an earlier group is unavailable while that group is Skip', () => {
    const d = choose({ g11: { choice: 'skip' } }, g2, 'same', g2.candidates[0].ref);
    expect(d.g14).toEqual({ choice: 'same' });
    expect(isResolved(g2, d)).toBe(false);
    // a Same decision becomes unresolved when its target group is later skipped
    const both = { g11: { choice: 'skip' as const }, g14: { choice: 'same' as const, target: { type: 'group' as const, key: 'g11' } } };
    expect(isResolved(g2, both)).toBe(false);
  });
  it('builds the strict request: one decision per flagged appliance', () => {
    const d = { g11: { choice: 'same' as const, target: { type: 'appliance' as const, id: 'a1' } }, g14: { choice: 'skip' as const } };
    expect(toRequest(p, d)).toEqual({ import_id: 'i', plan_hash: 'h', confirm: true, decisions: [{ key: 'g11', choice: 'same', target: { type: 'appliance', id: 'a1' } }, { key: 'g14', choice: 'skip' }] });
  });
  it('after preview_stale keeps decisions only for unchanged groups', () => {
    const fresh = plan([g1, grp('g14', [cand({ ref: { type: 'group', key: 'g11' }, name: 'CHANGED' })])], []);
    const c = carryDecisions(p, fresh, { g11: { choice: 'skip' }, g14: { choice: 'skip' } });
    expect(Object.keys(c.decisions)).toEqual(['g11']);
    expect(c.changed).toEqual(['g14']);
  });
});

describe('preview grouping and counts', () => {
  const rows = [
    row(2, 'update', { target: { client_id: 'c1', client_name: 'Halvorsen', appliance: { id: 'x', name: 'APP-2', is_new: false }, metric: { id: 'm', is_new: false } }, fills: { location: 'Chicago' } }),
    row(3, 'new'),
    row(8, 'needs_review', { review_key: 'g8' }),
    row(15, 'invalid', { target: null, errors: [{ field: 'account', code: 'account_not_found', text: 'Row 15: Account "X" not found.' }] }),
  ];
  const p = plan([grp('g8', [cand()])], rows);
  it('groups rows by account and appliance, orphans last', () => {
    const g = groupRows(p, 'all', '');
    expect(g.map((x) => x.appliance)).toEqual(['APP-2', 'APP-3', 'APP-8', null]);
    expect(g[0].badge).toBe('fills');
    expect(g[0].sub).toBe('Location blank, file gives Chicago');
    expect(g[1].badge).toBe('new');
    expect(g[2].badge).toBe('review');
    expect(g[3].orphan).toBe(true);
  });
  it('filters and searches', () => {
    expect(groupRows(p, 'invalid', '').flatMap((x) => x.rows.map((r) => r.row))).toEqual([15]);
    expect(groupRows(p, 'all', 't3').flatMap((x) => x.rows.map((r) => r.row))).toEqual([3]);
    expect(filterCount(p, 'needs_review')).toBe(1);
  });
});

describe('error mapping and links', () => {
  const err = (code: ConstructorParameters<typeof DataSourceError>[0], details?: Record<string, unknown>, message = 'm') => new DataSourceError(code, message, undefined, 400, details);
  it('header_missing names the column and the found headers (mockup 09C)', () => {
    const m = mapBamsError(err('invalid_file', { reason: 'header_missing', missing: ['Ticker'], found: ['Account', 'Appliance'] }));
    expect(m.title).toBe('Missing required column: Ticker');
    expect(m.detail).toContain('Found: Account, Appliance');
  });
  it('too many rows, expired, stale, unresolved, failed', () => {
    expect(mapBamsError(err('invalid_file', { reason: 'too_many_rows', found: 612, limit: 500 })).title).toBe('Too many rows: 612 data rows, limit is 500');
    expect(mapBamsError(err('import_expired')).kind).toBe('expired');
    expect(mapBamsError(err('preview_stale', { why: 'ticker_conflict' })).kind).toBe('stale');
    expect(mapBamsError(err('unresolved_duplicates', { keys: ['g1', 'g2'] })).keys).toEqual(['g1', 'g2']);
    const f = mapBamsError(err('import_failed', { rolled_back: true, row: 14, reason: 'Ticker X was added elsewhere.', backup: 'b.db' }));
    expect(f.kind).toBe('failed');
    expect(f.failed).toEqual({ row: 14, reason: 'Ticker X was added elsewhere.', backup: 'b.db' });
  });
  it('Open BAMS passes the touched accounts comma separated', () => {
    expect(openBamsPath({ touched_accounts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } as never)).toBe('/bams?account=a,b');
    expect(openBamsPath(null)).toBe('/bams');
  });
});

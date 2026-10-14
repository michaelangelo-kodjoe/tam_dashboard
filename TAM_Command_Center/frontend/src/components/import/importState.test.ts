import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../../data/DataSource';
import type { ImportPlan, ImportRow, SimilarCandidate } from '../../types';
import {
  candidateDisabled, canApply, carryDecisions, chooseOption, chooseTarget, filterRows, isResolved, mapImportError, needsDiscardGuard, resolvedCount, toRequest, unresolvedRows,
  type Decisions,
} from './importState';

const cand = (ref: SimilarCandidate['ref'], name = 'X', extra: Partial<SimilarCandidate> = {}): SimilarCandidate => ({
  ref, name, bpid: null, products: null, status: 'Active', next_contact: null, strength: 'High', reasons: [], differences: [], fills: {}, kept: {}, notes: [], ...extra,
});
const flaggedRow = (row: number, candidates: SimilarCandidate[]): ImportRow => ({
  row, state: 'needs_review', values: { name: `N${row}`, bpid: null, products: null, status: null, next_contact: null, notes: null }, raw: null, errors: [], warnings: [], match: null, merged_into: null, candidates,
});
const plain = (row: number, state: ImportRow['state']): ImportRow => ({ ...flaggedRow(row, []), state });
const plan = (rows: ImportRow[]): ImportPlan => ({
  import_id: 'i1', plan_hash: 'h1', expires_at: '', file: { name: 'f.csv', size_bytes: 1, rows_found: rows.length, format: 'csv', sheet: 'CSV', encoding: 'UTF-8', delimiter: 'comma', notes: [] }, limits: { max_rows: 500, max_candidates: 5 },
  counts: { rows: rows.length, valid: rows.filter((r) => r.state !== 'invalid').length, new: rows.filter((r) => r.state === 'new').length, updates: rows.filter((r) => r.state === 'update').length, needs_review: rows.filter((r) => r.state === 'needs_review').length, invalid: rows.filter((r) => r.state === 'invalid').length },
  warnings: [], rows,
});
const A1 = { type: 'account' as const, id: 'a1' };
const A2 = { type: 'account' as const, id: 'a2' };
const R5 = { type: 'row' as const, row: 5 };

describe('decision rules (D-43)', () => {
  const p = plan([plain(5, 'new'), flaggedRow(6, [cand(A1)]), flaggedRow(7, [cand(A1), cand(A2)]), flaggedRow(8, [cand(R5)])]);
  it('nothing is preselected: no flagged row is resolved on arrival and Apply is gated', () => {
    expect(resolvedCount(p, {})).toBe(0);
    expect(unresolvedRows(p, {})).toEqual([6, 7, 8]);
    expect(canApply(p, {})).toBe(false);
  });
  it('Different and Skip resolve immediately; Same with one candidate picks it; Same with several waits for a target', () => {
    let d: Decisions = {};
    d = chooseOption(p, d, 6, 'same');
    expect(d[6]).toEqual({ choice: 'same', target: A1 });
    d = chooseOption(p, d, 7, 'same');
    expect(d[7]).toEqual({ choice: 'same' });
    expect(isResolved(p.rows[2], d)).toBe(false);
    d = chooseTarget(d, 7, A2);
    expect(isResolved(p.rows[2], d)).toBe(true);
    d = chooseOption(p, d, 8, 'different');
    expect(d[8]).toEqual({ choice: 'different' });
    expect(canApply(p, d)).toBe(true);
    expect(resolvedCount(p, d)).toBe(3);
  });
  it('switching away from Same drops the target; switching back to Same keeps a still-valid target', () => {
    let d = chooseTarget({}, 7, A1);
    d = chooseOption(p, d, 7, 'skip');
    expect(d[7]).toEqual({ choice: 'skip' });
    d = chooseOption(p, d, 7, 'same');
    expect(d[7].target).toBeUndefined();
    d = chooseOption(p, chooseTarget(d, 7, A2), 7, 'same');
    expect(d[7].target).toEqual(A2);
  });
  it('Same onto an earlier row is disabled while that row is Skip, and a decision that depends on it becomes unresolved', () => {
    const rp = plan([flaggedRow(5, [cand(A1)]), flaggedRow(6, [cand(R5)])]);
    let d: Decisions = chooseOption(rp, {}, 5, 'different');
    d = chooseOption(rp, d, 6, 'same');
    expect(d[6]).toEqual({ choice: 'same', target: R5 });
    expect(isResolved(rp.rows[1], d)).toBe(true);
    d = chooseOption(rp, d, 5, 'skip');
    expect(candidateDisabled(rp.rows[1].candidates[0], d)).toBe(true);
    expect(isResolved(rp.rows[1], d)).toBe(false);
    expect(canApply(rp, d)).toBe(false);
    expect(chooseOption(rp, d, 6, 'same')[6].target).toBeUndefined(); // cannot be re-picked while disabled
  });
  it('the request carries exactly one decision per flagged row, in row order, with a target only for Same', () => {
    const d: Decisions = { 6: { choice: 'same', target: A1 }, 7: { choice: 'skip' }, 8: { choice: 'different' } };
    expect(toRequest(p, d)).toEqual({
      import_id: 'i1', plan_hash: 'h1', confirm: true,
      decisions: [{ row: 6, choice: 'same', target: A1 }, { row: 7, choice: 'skip' }, { row: 8, choice: 'different' }],
    });
  });
  it('nothing valid to apply keeps Apply off', () => {
    expect(canApply(plan([plain(2, 'invalid')]), {})).toBe(false);
    expect(canApply(plan([plain(2, 'new')]), {})).toBe(true);
  });
});

describe('preview_stale: carry decisions over', () => {
  it('keeps decisions whose candidate set is unchanged and reports the rest', () => {
    const old = plan([flaggedRow(6, [cand(A1, 'A', { row_version: 1 })]), flaggedRow(7, [cand(A2, 'B', { row_version: 1 })])]);
    const fresh = plan([flaggedRow(6, [cand(A1, 'A', { row_version: 1 })]), flaggedRow(7, [cand(A2, 'B', { row_version: 2 })])]);
    const d: Decisions = { 6: { choice: 'same', target: A1 }, 7: { choice: 'skip' } };
    const r = carryDecisions(old, fresh, d);
    expect(r.decisions).toEqual({ 6: d[6] });
    expect(r.changed).toEqual([7]);
  });
  it('a row that newly needs review has no decision', () => {
    const old = plan([plain(6, 'new')]);
    const fresh = plan([flaggedRow(6, [cand(A1)])]);
    expect(carryDecisions(old, fresh, {}).changed).toEqual([6]);
  });
});

describe('filters and the discard guard', () => {
  it('filters by state', () => {
    const p = plan([plain(2, 'new'), plain(3, 'update'), plain(4, 'invalid'), flaggedRow(5, [cand(A1)])]);
    expect(filterRows(p, 'all')).toHaveLength(4);
    expect(filterRows(p, 'invalid').map((r) => r.row)).toEqual([4]);
    expect(filterRows(p, 'needs_review').map((r) => r.row)).toEqual([5]);
  });
  it('guards closing only while a file is inspected and nothing was applied', () => {
    const p = plan([plain(2, 'new')]);
    expect(needsDiscardGuard('file', null, null)).toBe(false);
    expect(needsDiscardGuard('preview', p, null)).toBe(true);
    expect(needsDiscardGuard('review', p, null)).toBe(true);
    expect(needsDiscardGuard('result', p, { import_id: 'i1' } as never)).toBe(false);
  });
});

describe('error mapping (clear messages, D-44)', () => {
  const err = (code: ConstructorParameters<typeof DataSourceError>[0], details?: Record<string, unknown>, message = 'server text') => mapImportError(new DataSourceError(code, message, undefined, 409, details));
  it('invalid_file reasons', () => {
    expect(err('invalid_file', { reason: 'too_many_rows', found: 812, limit: 500 }).message).toBe('This file has 812 account rows. The limit is 500 per import. Split the file and import it in parts.');
    expect(err('invalid_file', { reason: 'not_csv' }).message).toMatch(/not a spreadsheet or a CSV/);
    expect(err('invalid_file', { reason: 'macros' }).message).toMatch(/macros/);
    expect(err('invalid_file', { reason: 'not_xlsx' }).message).toMatch(/not a real Excel workbook/);
    expect(err('invalid_file', { reason: 'unsupported_type' }).message).toBe('Only .xlsx and .csv files can be imported.');
    expect(err('invalid_file', { reason: 'header_missing' }, 'No Account name column.').message).toBe('No Account name column.');
    expect(err('invalid_file', { reason: 'something_new' }, 'Server says no.').message).toBe('Server says no.');
    expect(err('payload_too_large').message).toMatch(/larger than 5 MB/);
    expect(err('invalid_file', { reason: 'unsupported_type' }).kind).toBe('file');
  });
  it('import_expired, preview_stale, unresolved_duplicates, already_applied, backup_failed', () => {
    expect(err('import_expired')).toMatchObject({ kind: 'expired', message: 'This import timed out. Choose the file again.' });
    expect(err('preview_stale').kind).toBe('stale');
    expect(err('unresolved_duplicates', { rows: [4, 9] })).toMatchObject({ kind: 'unresolved', rows: [4, 9], message: '2 similar rows still need a decision: row 4, 9.' });
    expect(err('already_applied', { result: { import_id: 'x' } }).result).toEqual({ import_id: 'x' });
    expect(err('backup_failed')).toMatchObject({ kind: 'backup' });
    expect(err('backup_failed').message).toMatch(/nothing was changed/);
    expect(mapImportError(new Error('boom')).kind).toBe('generic');
    expect(err('network', undefined, 'Could not reach the server.').message).toBe('Could not reach the server.');
  });
});

import { describe, expect, it } from 'vitest';
import { defaultQuarter, deriveDate, deriveVersion, isExpanded, isOverdue, summaryText, toggleGroup, triState, filtersActive } from './operations';
import type { OpsQuarter } from '../opsTypes';

const q = (over: Partial<OpsQuarter> = {}): OpsQuarter => ({ year: 2026, quarter: 'Q4', label: '2026 Q4', target_version: '4.78.0', dev_date: '2026-10-10', east_prod_date: '2026-11-07', west_prod_date: '2026-11-14', row_version: 1, records: 0, ...over });

describe('deriveDate (backend golden cases, contract 13)', () => {
  it.each([
    ['DEV', null, '2026-10-10'], ['PROD', 'East', '2026-11-07'], ['PROD', 'West', '2026-11-14'],
  ] as const)('%s %s -> %s', (environment, polarity, expected) => {
    expect(deriveDate({ environment, polarity, quarter: q(), override: null })).toMatchObject({ effective: expected, source: 'quarter', reason: null });
  });
  it('override wins and keeps the derived date', () => {
    expect(deriveDate({ environment: 'DEV', polarity: null, quarter: q(), override: '2026-12-01' })).toMatchObject({ effective: '2026-12-01', source: 'override', derived: '2026-10-10' });
  });
  it('names the specific reason', () => {
    expect(deriveDate({ environment: null, polarity: null, quarter: q(), override: null }).reason).toBe('Set Environment (PROD or DEV)');
    expect(deriveDate({ environment: 'PROD', polarity: null, quarter: q(), override: null }).reason).toBe('Set East or West');
    expect(deriveDate({ environment: 'PROD', polarity: 'East', quarter: q({ east_prod_date: null }), override: null }).reason).toBe('No PROD East date in 2026 Q4');
    expect(deriveDate({ environment: 'DEV', polarity: null, quarter: q({ dev_date: null }), override: null }).reason).toBe('No DEV date in 2026 Q4');
  });
});

describe('version, overdue, default quarter', () => {
  it('own version beats the quarter default; blank follows it', () => {
    expect(deriveVersion('5.0.1', '4.78.0')).toMatchObject({ effective: '5.0.1', source: 'appliance' });
    expect(deriveVersion(null, '4.78.0')).toMatchObject({ effective: '4.78.0', source: 'quarter' });
    expect(deriveVersion(null, null)).toMatchObject({ effective: null, source: 'none' });
  });
  it('overdue boundary: yesterday yes, today no, Completed/Deferred never', () => {
    expect(isOverdue('2026-10-13', 'Planned', '2026-10-14')).toBe(true);
    expect(isOverdue('2026-10-14', 'Planned', '2026-10-14')).toBe(false);
    expect(isOverdue('2026-10-01', 'Completed', '2026-10-14')).toBe(false);
    expect(isOverdue('2026-10-01', 'Deferred', '2026-10-14')).toBe(false);
    expect(isOverdue(null, 'Planned', '2026-10-14')).toBe(false);
  });
  it('default quarter = earliest date on/after today, else latest', () => {
    const q3 = q({ quarter: 'Q3', label: '2026 Q3', dev_date: '2026-06-20', east_prod_date: '2026-07-25', west_prod_date: null });
    const q1 = q({ year: 2027, quarter: 'Q1', label: '2027 Q1', dev_date: '2027-01-15', east_prod_date: null, west_prod_date: null });
    expect(defaultQuarter([q3, q(), q1], '2026-10-14')?.label).toBe('2026 Q4');
    expect(defaultQuarter([q3, q(), q1], '2026-11-20')?.label).toBe('2027 Q1');
    expect(defaultQuarter([q3, q(), q1], '2028-01-01')?.label).toBe('2027 Q1');
    expect(defaultQuarter([], '2026-10-14')).toBeNull();
  });
});

describe('summary, selection, expand', () => {
  it('summary text omits zero counts and carries Overdue; no percentages', () => {
    const t = summaryText(6, { total: 6, by_status: { Planned: 3, Scheduled: 2, Completed: 1, Deferred: 0 }, overdue: 1 });
    expect(t).toBe('6 appliances: 3 Planned, 2 Scheduled, 1 Overdue, 1 Completed');
    expect(t).not.toMatch(/%/);
    expect(summaryText(1, { total: 1, by_status: { Planned: 1 }, overdue: 0 })).toBe('1 appliance: 1 Planned');
  });
  it('tri-state and group toggle include every child', () => {
    const ids = ['a', 'b', 'c'];
    expect(triState(ids, new Set())).toBe('none');
    expect(triState(ids, new Set(['a']))).toBe('some');
    expect(triState(ids, new Set(ids))).toBe('all');
    expect([...toggleGroup(ids, new Set(['a']))].sort()).toEqual(ids);
    expect([...toggleGroup(ids, new Set([...ids, 'z']))]).toEqual(['z']);
  });
  it('active filters auto-expand unless the user collapsed the group; otherwise default collapsed', () => {
    expect(isExpanded('x', new Set(), new Set(), false)).toBe(false);
    expect(isExpanded('x', new Set(['x']), new Set(), false)).toBe(true);
    expect(isExpanded('x', new Set(), new Set(), true)).toBe(true);
    expect(isExpanded('x', new Set(), new Set(['x']), true)).toBe(false);
    expect(filtersActive({ q: ' ', status: null, environment: null, polarity: null })).toBe(false);
    expect(filtersActive({ q: '', status: 'Planned', environment: null, polarity: null })).toBe(true);
  });
});

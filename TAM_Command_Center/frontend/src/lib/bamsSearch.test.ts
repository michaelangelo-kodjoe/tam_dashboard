import { describe, expect, it } from 'vitest';
import { buildSuggestions, choiceQuery, searchChoices } from './bamsSearch';

const filters = {
  accounts: [{ id: 'c1', name: 'Castellan Peak' }, { id: 'c2', name: 'Acme Capital' }],
  locations: [],
  objects: [{ id: 'o1', name: 'BPOD-NY-01', client_id: 'c1', client_name: 'Castellan Peak' }, { id: 'o2', name: 'SAPI-01', client_id: 'c2', client_name: 'Acme Capital' }],
  metrics: ['CPU utilization %', 'Active sessions'],
};
const rows = [{ ticker: 'BMSEN CPU NY01 Index' }, { ticker: 'BMSEN CPU NY01 Index' }, { ticker: '' }];

describe('BAMS search suggestions', () => {
  it('returns nothing for empty text or no data', () => {
    expect(buildSuggestions(filters, rows, '  ')).toEqual([]);
    expect(buildSuggestions(undefined, rows, 'cpu')).toEqual([]);
  });
  it('matches appliances, accounts, metrics and tickers, prefix matches first, tickers de-duplicated', () => {
    const s = buildSuggestions(filters, rows, 'cpu');
    expect(s.map((x) => x.id)).toEqual(['metric:CPU utilization %', 'ticker:BMSEN CPU NY01 Index']);
    const c = buildSuggestions(filters, rows, 'castellan');
    expect(c.map((x) => x.kind)).toEqual(['account', 'appliance']); // account starts with it; appliance matches via its account name
    expect(c[0].score).toBe(0);
    expect(c[1].score).toBe(1);
  });
  it('is capped at 8', () => {
    const many = { ...filters, metrics: Array.from({ length: 30 }, (_, i) => `Metric ${i}`) };
    expect(buildSuggestions(many, [], 'metric')).toHaveLength(8);
  });
  it('always ends with "search all fields"', () => {
    const ch = searchChoices(buildSuggestions(filters, rows, 'zzz'), ' zzz ');
    expect(ch).toEqual([{ id: 'search:all', kind: 'search', label: 'zzz', meta: 'Search all fields', value: 'zzz' }]);
  });
  it('maps a choice to a URL patch', () => {
    const [ap] = buildSuggestions(filters, rows, 'bpod');
    expect(choiceQuery(ap)).toEqual({ object_id: 'o1', account: null, q: null });
    expect(choiceQuery({ id: 'x', kind: 'metric', label: 'm', meta: '', value: 'CPU' })).toEqual({ metric: 'CPU', q: null });
    expect(choiceQuery({ id: 'x', kind: 'search', label: 'm', meta: '', value: 'abc' })).toEqual({ q: 'abc' });
  });
});

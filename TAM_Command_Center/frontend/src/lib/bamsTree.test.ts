import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BamsRow } from '../bamsTypes';
import { buildMetricTree, isAccountOpen, loadMasterOpen, saveMasterOpen, worstSeverity } from './bamsTree';

const row = (id: string, client: string, appl: string, metric: string, sev?: 'Warning' | 'Critical' | 'Info', status: 'open' | 'recovered' | 'closed' = 'open'): BamsRow => ({
  id, metric_name: metric, object: { id: `o-${appl}`, name: appl, client_id: `c-${client}`, client_name: client },
  alert: sev ? { id: `a${id}`, status, severity: sev, opened_at: '2026-10-14T00:00:00Z' } : null,
} as unknown as BamsRow);

const rows = [
  row('1', 'Zeta', 'BPOD-2', 'CPU'), row('2', 'Acme', 'BPOD-1', 'CPU', 'Warning'), row('3', 'Acme', 'BPOD-1', 'Memory', 'Critical'),
  row('4', 'Acme', 'BPOD-0', 'Latency'), row('5', 'Acme', 'BPOD-0', 'Old', 'Critical', 'closed'),
];

describe('buildMetricTree', () => {
  const t = buildMetricTree(rows);
  it('groups by account, then appliance, sorted by name', () => {
    expect(t.map((a) => a.name)).toEqual(['Acme', 'Zeta']);
    expect(t[0].appliances.map((o) => o.name)).toEqual(['BPOD-0', 'BPOD-1']);
    expect(t[0].count).toBe(4);
    expect(t[1].count).toBe(1);
  });
  it('shows the worst active severity, ignoring closed alerts', () => {
    expect(t[0].worst).toBe('Critical');
    expect(t[0].appliances[0].worst).toBeNull(); // only a closed Critical
    expect(t[1].worst).toBeNull();
    expect(worstSeverity([rows[1]])).toBe('Warning');
  });
  it('filters across account, appliance and metric names', () => {
    expect(buildMetricTree(rows, 'memory')[0].count).toBe(1);
    expect(buildMetricTree(rows, 'zeta')).toHaveLength(1);
    expect(buildMetricTree(rows, 'nothing')).toEqual([]);
  });
});

describe('isAccountOpen', () => {
  it('master decides unless overridden; filtering opens everything; selected account opens', () => {
    expect(isAccountOpen('a', { master: false, overrides: {}, filtering: false })).toBe(false);
    expect(isAccountOpen('a', { master: true, overrides: {}, filtering: false })).toBe(true);
    expect(isAccountOpen('a', { master: true, overrides: { a: false }, filtering: false })).toBe(false);
    expect(isAccountOpen('a', { master: false, overrides: { a: false }, filtering: true })).toBe(true);
    expect(isAccountOpen('a', { master: false, overrides: {}, filtering: false, selectedAccountId: 'a' })).toBe(true);
  });
});

describe('master memory', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() }; };
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('defaults to collapsed and remembers the change', () => {
    vi.stubGlobal('localStorage', mem());
    expect(loadMasterOpen()).toBe(false);
    saveMasterOpen(true);
    expect(loadMasterOpen()).toBe(true);
    saveMasterOpen(false);
    expect(loadMasterOpen()).toBe(false);
  });
  it('survives storage that throws', () => {
    const deny = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny });
    expect(loadMasterOpen()).toBe(false);
    expect(() => saveMasterOpen(true)).not.toThrow();
  });
});

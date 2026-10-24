import { describe, expect, it } from 'vitest';
import type { BamsConfig, BamsMetricCatalogItem } from '../bamsTypes';
import { EMPTY_FORM, buildPolicyInput, exactMetric, formFromPolicy, isPattern, previewText, scopeText } from './bamsPolicy';

const catalog: BamsMetricCatalogItem[] = [
  { metric_name: 'CPU Utilization', metric_count: 12, appliance_count: 12, account_count: 3 },
  { metric_name: 'Memory Available', metric_count: 1, appliance_count: 1, account_count: 1 },
];
const form = { ...EMPTY_FORM, metric: 'cpu utilization', threshold: '90' };

describe('policy helpers', () => {
  it('matches the catalog case-insensitively and describes scope', () => {
    expect(exactMetric(catalog, ' cpu UTILIZATION ')?.metric_name).toBe('CPU Utilization');
    expect(scopeText(catalog[0], 'x')).toBe('12 appliances · 3 accounts');
    expect(scopeText(catalog[1], 'x')).toBe('1 appliance · 1 account');
    expect(scopeText(null, 'Foo')).toBe('Choose an exact metric from the catalog.');
    expect(scopeText(null, '')).toBe('Select a metric to see its scope.');
    expect(isPattern('CPU*')).toBe(true);
    expect(isPattern('CPU Utilization')).toBe(false);
  });
  it('previews', () => {
    expect(previewText('CPU Utilization', '>', '90', 'Critical', 2)).toBe('CPU Utilization > 90 · Critical · 2 updates');
    expect(previewText('', '>', '', 'Warning', 1)).toBe('Choose a metric, condition and threshold.');
  });
  it('builds a persistent fixed-threshold body using the catalog spelling', () => {
    const r = buildPolicyInput(form, catalog, null);
    if ('error' in r) throw new Error(r.error);
    expect(r.body).toMatchObject({ metric_match: 'CPU Utilization', rule_type: 'fixed_threshold', operator: '>', threshold: 90, auto_apply: true, enabled: true, cooldown_minutes: 15 });
    expect(r.body.name).toBe('CPU Utilization · > 90 · Warning');
    expect(r.body.id).toBeUndefined();
  });
  it('rejects bad input with the first error', () => {
    expect(buildPolicyInput({ ...form, metric: 'Nope' }, catalog, null)).toEqual({ error: 'Choose an exact metric from the BAMS metric catalog.' });
    expect(buildPolicyInput({ ...form, threshold: '' }, catalog, null)).toEqual({ error: 'Enter a valid threshold.' });
    expect(buildPolicyInput({ ...form, consecutive: '0' }, catalog, null)).toEqual({ error: 'Consecutive updates must be 1 or greater.' });
    expect(buildPolicyInput({ ...form, cooldown: '-1' }, catalog, null)).toEqual({ error: 'Cooldown must be 0 or greater.' });
  });
  it('edit keeps id, name and row version', () => {
    const p = { id: 'p1', name: 'Mine', metric_match: 'CPU Utilization', rule_type: 'fixed_threshold', operator: '<', threshold: 5, reference_period: null, consecutive_updates: 3, severity: 'Critical', cooldown_minutes: 0, enabled: false, starter: false, auto_apply: true, row_version: 4, preview: '', matches: 12 } as BamsConfig;
    const f = formFromPolicy(p);
    expect(f).toMatchObject({ metric: 'CPU Utilization', operator: '<', threshold: '5', consecutive: '3', cooldown: '0', enabled: false });
    const r = buildPolicyInput({ ...f, threshold: '7' }, catalog, p);
    if ('error' in r) throw new Error(r.error);
    expect(r.body).toMatchObject({ id: 'p1', name: 'Mine', expected_row_version: 4, threshold: 7 });
  });
});

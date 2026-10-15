import { describe, expect, it } from 'vitest';
import { breaches, formatAge, formatHighDate, formatSeconds, formatValue, globMatch, ruleCondition, ruleLevel, rulePreview } from './bams';
import { spreadLabels } from '../pages/bams/TrendChart';

const highs = { d30: { value: 1688, date: '2026-10-03' }, d60: { value: 1702, date: null }, d90: { value: 1755, date: '2026-07-21' } };

describe('BAMS formatting: every value is a percentage', () => {
  it('formats values with one decimal and a % sign', () => {
    expect(formatValue(91.4)).toBe('91.4%');
    expect(formatValue(73)).toBe('73.0%');
    expect(formatValue(1412)).toBe('1,412.0%');
    expect(formatValue(null)).toBe('');
  });
  it('ages read like the mockup', () => {
    expect(formatAge(null)).toBe('never');
    expect(formatAge(12)).toBe('12 s');
    expect(formatAge(98)).toBe('1 m 38 s');
    expect(formatAge(845)).toBe('14 m 05 s');
    expect(formatAge(7500)).toBe('2 h 05 m');
  });
  it('seconds and high dates', () => {
    expect(formatSeconds(60)).toBe('60 s');
    expect(formatSeconds(300)).toBe('5 min');
    expect(formatHighDate('2026-10-03')).toBe('3 Oct');
  });
});

describe('rule sentences match the backend preview (contract §11.1)', () => {
  it('threshold', () => {
    expect(rulePreview('CPU utilisation %', { rule_type: 'fixed_threshold', operator: '>', threshold: 85, reference_period: null, consecutive_updates: 3, severity: 'Warning' })).toBe('Alerts when CPU utilisation % > 85 for 3 updates (Warning)');
  });
  it('percent of high names the 90-day high and its value', () => {
    expect(rulePreview('Active sessions', { rule_type: 'pct_of_high', operator: '>', threshold: 90, reference_period: '90d', consecutive_updates: 2, severity: 'Critical' }, highs)).toBe('Alerts when Active sessions > 90% of the 90-day high (1,755) for 2 updates (Critical)');
  });
  it('exceeds high, singular update, number omitted when the high is unknown', () => {
    expect(rulePreview('Active sessions', { rule_type: 'exceeds_high', operator: '>', threshold: null, reference_period: '90d', consecutive_updates: 1, severity: 'Critical' }, highs)).toBe('Alerts when Active sessions exceeds the 90-day high (1,755) for 1 update (Critical)');
    expect(rulePreview('X', { rule_type: 'exceeds_high', threshold: null, reference_period: '30d', consecutive_updates: 1, severity: 'Info' })).toBe('Alerts when X exceeds the 30-day high for 1 update (Info)');
  });
  it('conditions, levels and breach tests', () => {
    expect(ruleCondition({ rule_type: 'pct_of_high', operator: '>=', threshold: 90, reference_period: '90d', consecutive_updates: 1, severity: 'Info' })).toBe('>= 90% of 90-day high');
    expect(ruleLevel({ rule_type: 'pct_of_high', threshold: 50, reference_period: '30d', consecutive_updates: 1, severity: 'Info' }, highs)).toBe(844);
    expect(ruleLevel({ rule_type: 'exceeds_high', threshold: null, reference_period: '60d', consecutive_updates: 1, severity: 'Info' }, highs)).toBe(1702);
    expect(breaches('>', 86, 85)).toBe(true);
    expect(breaches('>', 85, 85)).toBe(false);
    expect(breaches('<=', 85, 85)).toBe(true);
  });
  it('GLOB templates match case-insensitively', () => {
    expect(globMatch('CPU*', 'cpu utilisation %')).toBe(true);
    expect(globMatch('*Disk*', 'Disk Usage (%)')).toBe(true);
    expect(globMatch('Latency?', 'Latency ms')).toBe(false);
  });
});

describe('trend labels never overlap', () => {
  it('spreads labels at least the gap apart and keeps order', () => {
    const out = spreadLabels([100, 100, 100, 104], 13);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(13);
    expect(out[0]).toBeLessThanOrEqual(out[1]);
  });
});

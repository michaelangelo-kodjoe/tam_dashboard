import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../types';
import { buildChips, effectiveShow, groupByTier, keyFacts, openLabel, parseShow, reconcileSelection, rowWhen, scopeItems, whySentence, itemKey } from './triage';

const mk = (over: Partial<QueueItem> & { id: string; tier: number | null }): QueueItem => ({
  kind: 'task', tier_label: over.tier ? `Tier ${over.tier}` : null, client_id: 'c1', client_name: 'Acme', type_label: 'Task', title: `T ${over.id}`,
  status: 'Not Started', priority: 'High', severity: null, urgency: 'overdue', date: '2026-10-10', date_kind: 'due', days_delta: -3, context: null, server_name: null, ...over,
});
const TODAY = '2026-10-13';
const queue = (n: number, tier = 1) => Array.from({ length: n }, (_, i) => mk({ id: `${tier}-${i}`, tier }));

describe('chips and scopes', () => {
  const q = [...queue(7, 1), ...queue(3, 2), ...queue(5, 4)];
  it('Top 10 is strictly the first 10 of the queue; counts are never capped', () => {
    expect(scopeItems(q, 'top').map((i) => i.id)).toEqual(q.slice(0, 10).map((i) => i.id));
    const chips = buildChips(q);
    expect(chips.map((c) => c.label)).toEqual(['Top 10', 'Overdue / critical', 'Due today', 'Alerts', 'Waiting', 'Upgrades', 'Next 3 days', 'All']);
    expect(chips.map((c) => c.count)).toEqual([10, 7, 3, 0, 5, 0, 0, 15]);
    expect(chips.filter((c) => c.disabled).map((c) => c.id)).toEqual(['t3', 't5', 't6']);
  });
  it('a tier chip lists every item of that tier (no cap) and All lists the whole queue', () => {
    const big = queue(25, 1);
    expect(scopeItems(big, 't1')).toHaveLength(25);
    expect(scopeItems(big, 'all')).toHaveLength(25);
    expect(buildChips(big)[0].count).toBe(10);
  });
  it('with fewer than 10 items all are shown and the chip count is the length', () => {
    expect(scopeItems(queue(4), 'top')).toHaveLength(4);
    expect(buildChips(queue(4))[0].count).toBe(4);
  });
  it('parseShow falls back to top; effectiveShow avoids empty tiers', () => {
    expect(parseShow('t3')).toBe('t3');
    expect(parseShow('nonsense')).toBe('top');
    expect(parseShow(null)).toBe('top');
    expect(parseShow('plan')).toBe('top');
    expect(effectiveShow('t6', queue(3, 1))).toBe('top');
    expect(effectiveShow('t1', queue(3, 1))).toBe('t1');
  });
  it('groups consecutive tiers with a 1-based start position', () => {
    const g = groupByTier([...queue(2, 1), ...queue(3, 2)]);
    expect(g.map((x) => [x.tier, x.items.length, x.start])).toEqual([[1, 2, 1], [2, 3, 3]]);
  });
  it('never re-sorts: scope order equals queue order', () => {
    const shuffled = [mk({ id: 'b', tier: 2 }), mk({ id: 'a', tier: 1 })];
    expect(scopeItems(shuffled, 'all').map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('selection', () => {
  const items = queue(5);
  it('keeps the same item, else the same index clamped, else the first', () => {
    expect(reconcileSelection(items, itemKey(items[3]), 0)).toBe(3);
    expect(reconcileSelection(items.slice(0, 2), 'task:gone', 4)).toBe(1);
    expect(reconcileSelection(items, null, 0)).toBe(0);
    expect(reconcileSelection([], null, 0)).toBe(-1);
  });
});

describe('why-it-is-here sentences (PM §10.1 table)', () => {
  it('critical, overdue task and upgrade, due today, alert, recovered', () => {
    expect(whySentence(mk({ id: '1', tier: 1, kind: 'bams_alert', urgency: 'critical', server_name: 'bxa-1' }), TODAY)).toBe('Open Critical alert on bxa-1. Critical alerts always rank first.');
    expect(whySentence(mk({ id: '1', tier: 1 }), TODAY)).toBe('Overdue: due 10 Oct, 3 days ago. High priority.');
    expect(whySentence(mk({ id: '1', tier: 1, days_delta: -1, date: '2026-10-12' }), TODAY)).toBe('Overdue: due 12 Oct, 1 day ago. High priority.');
    expect(whySentence(mk({ id: '1', tier: 1, kind: 'server_upgrade', priority: null }), TODAY)).toBe('Upgrade scheduled for 10 Oct, 3 days ago, and not Completed or Deferred.');
    expect(whySentence(mk({ id: '1', tier: 2, urgency: 'due_today', days_delta: 0 }), TODAY)).toBe('Due today. High priority.');
    expect(whySentence(mk({ id: '1', tier: 3, kind: 'bams_alert', urgency: 'alert', severity: 'Warning', server_name: 'bxa-2', priority: null }), TODAY)).toBe('Open Warning alert on bxa-2.');
    expect(whySentence(mk({ id: '1', tier: 3, kind: 'bams_alert', urgency: 'recovered' }), TODAY)).toBe('Alert recovered and waiting to be closed.');
  });
  it('waiting, follow-up, upgrade, exception, validation, tier 6; missing values drop their clause', () => {
    expect(whySentence(mk({ id: '1', tier: 4, urgency: 'waiting', context: 'Waiting: J. Doe', date: '2026-10-12', date_kind: 'next_update' }), TODAY)).toBe('Waiting on J. Doe. Next update 12 Oct.');
    expect(whySentence(mk({ id: '1', tier: 4, urgency: 'waiting', date: null, date_kind: null }), TODAY)).toBe('Waiting. Next update is not set.');
    expect(whySentence(mk({ id: '1', tier: 4, kind: 'client_follow_up', urgency: 'follow_up', date: '2026-10-13', date_kind: 'next_contact' }), TODAY)).toBe('Next client touch is due 13 Oct.');
    expect(whySentence(mk({ id: '1', tier: 5, kind: 'server_upgrade', urgency: 'upgrade', date: '2026-10-19' }), TODAY)).toBe('Upgrade scheduled for 19 Oct, within 14 days.');
    expect(whySentence(mk({ id: '1', tier: 5, kind: 'server_upgrade', urgency: 'upgrade', status: 'Exception' }), TODAY)).toBe('Upgrade exception: needs attention at any date.');
    expect(whySentence(mk({ id: '1', tier: 5, kind: 'server_upgrade', urgency: 'validation', status: 'Validation Required' }), TODAY)).toBe('Upgrade needs validation: Validation Required.');
    expect(whySentence(mk({ id: '1', tier: 5, kind: 'server_upgrade', urgency: 'validation', status: 'Completed' }), TODAY)).toBe('Upgrade needs validation: Completed with validation Pending.');
    expect(whySentence(mk({ id: '1', tier: 6, urgency: 'upcoming', date: '2026-10-15', days_delta: 2 }), TODAY)).toBe('Due 15 Oct, within the next 3 days.');
    expect(whySentence(mk({ id: '1', tier: 2, urgency: 'due_today', priority: null }), TODAY)).toBe('Due today.');
  });
  it('never contains steps, scores or exclamation marks', () => {
    const s = whySentence(mk({ id: '1', tier: 1 }), TODAY);
    expect(s).not.toMatch(/!|score|step/i);
  });
});

describe('key facts and labels', () => {
  it('omits null facts and shows the dated fact with its kind label and relative text', () => {
    const f = keyFacts(mk({ id: '1', tier: 1, tier_label: 'Overdue / Critical', context: null, priority: null }), TODAY, 'local');
    expect(f.map((x) => x.label)).toEqual(['Account', 'Type', 'Due', 'Urgency', 'Status']);
    expect(f.find((x) => x.label === 'Due')!.value).toBe('10 Oct · 3d overdue');
    expect(f.every((x) => x.value.trim() !== '')).toBe(true);
  });
  it('unassigned tasks say No account; touches omit status', () => {
    expect(keyFacts(mk({ id: '1', tier: 1, client_id: null, client_name: null }), TODAY, 'local')[0].value).toBe('No account');
    expect(keyFacts(mk({ id: '1', tier: 4, kind: 'client_follow_up', type_label: 'Client touch', date_kind: 'next_contact' }), TODAY, 'local').some((x) => x.label === 'Status')).toBe(false);
  });
  it('open link text per kind', () => {
    expect(openLabel(mk({ id: '1', tier: 1 }))).toBe('Open task');
    expect(openLabel(mk({ id: '1', tier: 1, kind: 'client_follow_up' }))).toBe('Open account');
    expect(openLabel(mk({ id: '1', tier: 1, kind: 'bams_alert' }))).toBe('Open alert');
    expect(openLabel(mk({ id: '1', tier: 1, kind: 'server_upgrade' }))).toBe('Open infrastructure');
  });
  it('row date labels', () => {
    expect(rowWhen(mk({ id: '1', tier: 1 }), TODAY, 'local')).toEqual({ text: '3d overdue', tone: 'danger' });
    expect(rowWhen(mk({ id: '1', tier: 2, days_delta: 0, date: TODAY }), TODAY, 'local')).toEqual({ text: 'Today', tone: 'accent' });
    expect(rowWhen(mk({ id: '1', tier: 5, date: '2026-10-19', days_delta: 6, date_kind: 'scheduled' }), TODAY, 'local')).toEqual({ text: '19 Oct', tone: 'muted' });
  });
});

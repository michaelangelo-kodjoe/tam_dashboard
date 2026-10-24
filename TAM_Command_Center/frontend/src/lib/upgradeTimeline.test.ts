import { describe, expect, it } from 'vitest';
import type { Upgrade30 } from '../types';
import { buildColumns, markerLabel, markerTone, shortDate } from './upgradeTimeline';

const T = '2026-10-28';
const u = (o: Partial<Upgrade30>): Upgrade30 => ({ server_name: 's', date: '2026-11-05', status: 'Planned', environment: 'PROD', polarity: 'East', object_id: 'o', release: { year: 2026, quarter: 'Q4' }, ...o });

describe('upgrade timeline markers', () => {
  it('collapses to one marker per (date, polarity) regardless of appliance count, side by side West, East, DEV', () => {
    const cols = buildColumns([
      u({ server_name: 'a', polarity: 'East' }), u({ server_name: 'b', polarity: 'East' }), u({ server_name: 'c', polarity: 'East' }),
      u({ server_name: 'd', polarity: 'DEV', environment: 'DEV' }), u({ server_name: 'e', polarity: 'West' }), u({ server_name: 'f', polarity: null }),
    ], T);
    expect(cols).toHaveLength(1);
    expect(cols[0].markers.map((m) => m.polarity)).toEqual(['West', 'East', 'DEV', null]);
    expect(cols[0].markers.map((m) => m.label)).toEqual(['West PROD Upgrade, 5 Nov', 'East PROD Upgrade, 5 Nov', 'DEV Upgrade, 5 Nov', 'PROD Upgrade, 5 Nov']);
    expect(JSON.stringify(cols)).not.toMatch(/"server_name"|"a"|"b"/); // no appliance names
  });
  it('orders dates, drops out-of-window items, and positions by days from today', () => {
    const cols = buildColumns([u({ date: '2026-11-27' }), u({ date: '2026-10-28', polarity: 'West' }), u({ date: '2026-11-28' }), u({ date: '2026-10-27' })], T);
    expect(cols.map((c) => c.date)).toEqual(['2026-10-28', '2026-11-27']);
    expect(cols.map((c) => c.pct)).toEqual([0, 100]);
  });
  it('staggers date labels that would collide, and reuses row 0 when there is room', () => {
    const cols = buildColumns([u({ date: '2026-10-29' }), u({ date: '2026-10-30' }), u({ date: '2026-11-20' })], T);
    expect(cols.map((c) => c.row)).toEqual([0, 1, 0]);
  });
  it('maps label and colour per polarity', () => {
    expect(markerLabel('East', '2026-11-05')).toBe('East PROD Upgrade, 5 Nov');
    expect(markerLabel('West', '2026-11-05')).toBe('West PROD Upgrade, 5 Nov');
    expect(markerLabel('DEV', '2026-11-05')).toBe('DEV Upgrade, 5 Nov');
    expect(markerLabel(null, '2026-11-05')).toBe('PROD Upgrade, 5 Nov');
    expect(['West', 'East', 'DEV', null].map((p) => markerTone(p as never))).toEqual(['west', 'east', 'dev', 'unknown']);
    expect(shortDate('2026-12-01')).toBe('1 Dec');
  });
  it('empty input gives no columns', () => { expect(buildColumns([], T)).toEqual([]); });
});

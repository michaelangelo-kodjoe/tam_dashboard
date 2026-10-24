import { describe, expect, it } from 'vitest';
import { bandOf, dragToWindow, minWindowMs, severityLevels, severitySegments, tickStep, timeTicks, windowLabel } from './chartZoom';

const MIN = 60_000;
const T0 = new Date(2026, 9, 14, 0, 0).getTime();
const FULL: [number, number] = [T0, T0 + 24 * 60 * MIN];

describe('dragToWindow', () => {
  it('maps pixels to a minute-snapped window', () => {
    const w = dragToWindow(100, 300, 1000, FULL, FULL)!;
    expect(w[0]).toBe(T0 + 144 * MIN);
    expect(w[1]).toBe(T0 + 432 * MIN);
  });
  it('works right to left and clamps to the plot', () => {
    expect(dragToWindow(2000, -50, 1000, FULL, FULL)).toEqual(FULL);
  });
  it('ignores clicks under 8 px and windows under 3 minutes', () => {
    expect(dragToWindow(10, 15, 1000, FULL, FULL)).toBeNull();
    expect(dragToWindow(0, 9, 5000, [T0, T0 + 60 * MIN], FULL)).toBeNull(); // 9/5000*60 = 0.1 min
  });
  it('zooms again inside an existing zoom', () => {
    const view: [number, number] = [T0 + 600 * MIN, T0 + 700 * MIN];
    expect(dragToWindow(0, 500, 1000, view, FULL)).toEqual([T0 + 600 * MIN, T0 + 650 * MIN]);
  });
});

describe('zoom limits for the window API', () => {
  const week: [number, number] = [T0, T0 + 30 * 24 * 60 * MIN];
  it('caps a selection at 7 days', () => {
    const w = dragToWindow(0, 1000, 1000, week, week)!;
    expect(w[1] - w[0]).toBe(7 * 24 * 60 * MIN);
    expect(w[0]).toBe(T0);
  });
  it('needs about two sample intervals', () => {
    expect(minWindowMs(60)).toBe(3 * MIN);
    expect(minWindowMs(300)).toBe(10 * MIN);
    const hour: [number, number] = [T0, T0 + 60 * MIN];
    expect(dragToWindow(0, 100, 1000, hour, FULL, { minMs: minWindowMs(300) })).toBeNull(); // 6 min < 10 min
    expect(dragToWindow(0, 100, 1000, hour, FULL)).toEqual([T0, T0 + 6 * MIN]);
  });
});

describe('ticks', () => {
  it('gets finer as the window shrinks', () => {
    expect(tickStep(24 * 60 * MIN)).toBe(3 * 60 * MIN);
    expect(tickStep(30 * MIN)).toBe(5 * MIN);
    expect(timeTicks(T0, T0 + 30 * MIN).length).toBeLessThanOrEqual(9);
    expect(timeTicks(T0 + 1, T0 + 30 * MIN)[0]).toBe(T0 + 5 * MIN);
  });
  it('labels the window', () => {
    expect(windowLabel([T0 + 540 * MIN, T0 + 575 * MIN], FULL)).toBe('Zoomed: 14 Oct 09:00 to 14 Oct 09:35 (35 min)');
    expect(windowLabel(FULL, FULL).startsWith('Showing')).toBe(true);
  });
});

describe('severity segments', () => {
  const lv = severityLevels([
    { rule_id: 'a', value: 75, severity: 'Warning' }, { rule_id: 'b', value: 90, severity: 'Critical' }, { rule_id: 'c', value: 50, severity: 'Info' },
  ]);
  it('bands: normal below Warning, amber at Warning, red at Critical', () => {
    expect([60, 74.9, 75, 89.9, 90, 99].map((v) => bandOf(v, lv))).toEqual(['n', 'n', 'w', 'w', 'c', 'c']);
  });
  it('overlays three series that join at band changes', () => {
    const s = severitySegments([50, 80, 95, 60], lv);
    expect(s.n).toEqual([50, 80, null, 60]); // 50->80 segment is normal; 95->60 uses band of 95 (c), 60 is normal start
    expect(s.w).toEqual([null, 80, 95, null]);
    expect(s.c).toEqual([null, null, 95, 60]);
  });
  it('supports "below" rules from the operator and picks the most inclusive level', () => {
    const l = severityLevels([{ rule_id: 'x', value: 15, severity: 'Critical' }, { rule_id: 'y', value: 25, severity: 'Warning' }], [{ id: 'x', operator: '<' }, { id: 'y', operator: '<=' }]);
    expect([30, 25, 14].map((v) => bandOf(v, l))).toEqual(['n', 'w', 'c']);
  });
  it('no rules means everything is normal', () => {
    expect(bandOf(99, severityLevels([]))).toBe('n');
  });
});

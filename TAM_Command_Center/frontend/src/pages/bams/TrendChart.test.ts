import { describe, expect, it } from 'vitest';
import { uniqueTicks } from './TrendChart';

describe('uniqueTicks (QA-E5-4)', () => {
  it('yields each date label once', () => {
    const h = 3600e3; const t0 = Date.UTC(2026, 9, 8, 12);
    const ts = Array.from({ length: 150 }, (_, i) => t0 + i * h);
    const labels = uniqueTicks(ts, '30d').map((t) => { const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1}`; });
    expect(new Set(labels).size).toBe(labels.length);
  });
});

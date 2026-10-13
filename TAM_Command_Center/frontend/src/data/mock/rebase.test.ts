import { describe, expect, it } from 'vitest';
import { rebaseTables, shiftQuarter, quarterIndexOfDate } from './rebase';
import { mockFile } from './testFile';

describe('mock rebase rule (docs/03_DATA_MODEL.md §8)', () => {
  const f = mockFile();
  const anchorNow = new Date(f.anchor_now);

  it('is the identity when rebasing to the anchor date at the anchor instant', () => {
    const t = rebaseTables(f, { today: f.anchor_date, loadNow: anchorNow });
    expect(t.tasks[0].due).toBe(f.tables.tasks[0].due);
    expect(t.notes[0].timestamp).toBe(f.tables.notes[0].timestamp);
    expect(t.bams_metrics[0].last_received).toBe(f.tables.bams_metrics[0].last_received);
  });

  it('shifts date fields and instants by whole days, keeping time of day', () => {
    const t = rebaseTables(f, { today: '2026-10-17', loadNow: new Date(anchorNow.getTime() + 5 * 86_400_000) });
    const src = f.tables.tasks.find((x) => x.due)!;
    const out = t.tasks.find((x) => x.id === src.id)!;
    const d0 = Date.parse(src.due + 'T00:00:00Z');
    expect((Date.parse(out.due + 'T00:00:00Z') - d0) / 86_400_000).toBe(5);
    const n0 = f.tables.notes[0];
    const n1 = t.notes[0];
    expect(Date.parse(n1.timestamp) - Date.parse(n0.timestamp)).toBe(5 * 86_400_000);
    expect(n1.timestamp.slice(10)).toBe(n0.timestamp.slice(10));
  });

  it('shifts BAMS freshness fields by EXACTLY load_now - anchor_now (not whole days)', () => {
    const offsetMs = 36 * 3600_000 + 17_000; // 36h 17s
    const t = rebaseTables(f, { today: '2026-10-13', loadNow: new Date(anchorNow.getTime() + offsetMs) });
    const m0 = f.tables.bams_metrics.find((m) => m.last_received)!;
    const m1 = t.bams_metrics.find((m) => m.id === m0.id)!;
    expect(Date.parse(m1.last_received) - Date.parse(m0.last_received)).toBe(offsetMs);
    expect(Date.parse(m1.last_source_update) - Date.parse(m0.last_source_update)).toBe(offsetMs);
  });

  it('shifts audit JSON date/instant keys with the same delta', () => {
    const t = rebaseTables(f, { today: '2026-10-22', loadNow: anchorNow });
    const src = f.tables.audit_events.find((a) => a.new_value && a.new_value.includes('"due"') && JSON.parse(a.new_value).due)!;
    const out = t.audit_events.find((a) => a.id === src.id)!;
    const d0 = JSON.parse(src.new_value).due as string;
    const d1 = JSON.parse(out.new_value).due as string;
    expect((Date.parse(d1) - Date.parse(d0)) / 86_400_000).toBe(10);
  });

  it('shifts schedule quarters by whole quarters', () => {
    expect(shiftQuarter(2026, 'Q4', 1)).toEqual({ year: 2027, quarter: 'Q1' });
    expect(shiftQuarter(2026, 'Q1', -1)).toEqual({ year: 2025, quarter: 'Q4' });
    const t = rebaseTables(f, { today: '2027-01-12', loadNow: anchorNow });
    const k = quarterIndexOfDate('2027-01-12') - quarterIndexOfDate(f.anchor_date);
    expect(k).toBe(1);
    const w0 = f.tables.quarterly_upgrade_windows[0];
    expect(t.quarterly_upgrade_windows[0].schedule_year * 4 + Number(t.quarterly_upgrade_windows[0].schedule_quarter[1]) - (w0.schedule_year * 4 + Number(w0.schedule_quarter[1]))).toBe(1);
  });
});

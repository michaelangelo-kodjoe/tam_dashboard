// Mock rebase rule (docs/03_DATA_MODEL.md §8). Mirrors db/seed_mock.py:
//  1. date fields shift by delta = today_local - anchor_date (whole days);
//     instants shift by delta days keeping time of day; audit JSON keys likewise.
//  2. BAMS freshness fields shift by EXACTLY load_now - anchor_now (not whole days),
//     which keeps every metric's freshness state at the frozen mock clock.
//  3. (schedule_year, schedule_quarter) shift by whole quarters.
import { addDays, diffDays } from '../../lib/dates';

const DAY_MS = 86_400_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

export interface MockFile {
  format: string;
  anchor_date: string;
  anchor_now: string;
  rebase: {
    date_fields: Record<string, string[]>;
    instant_fields: Record<string, string[]>;
    quarter_fields: Record<string, string[]>;
    now_relative_fields: Record<string, string[]>;
    json_fields: Record<string, string[]>;
    json_date_keys: string[];
    json_instant_keys: string[];
  };
  app_meta: { key: string; value: string }[];
  tables: Tables;
}

export interface RebaseOptions {
  /** Local calendar date to rebase to. */
  today: string;
  /** Instant used as the frozen BAMS mock clock (rule 2). */
  loadNow: Date;
}

export function shiftInstant(s: string, days: number): string {
  return new Date(Date.parse(s) + days * DAY_MS).toISOString();
}

export function shiftQuarter(year: number, quarter: string, by: number): { year: number; quarter: string } {
  const idx = year * 4 + (Number(quarter.slice(1)) - 1) + by;
  return { year: Math.floor(idx / 4), quarter: `Q${(idx % 4) + 1}` };
}

export function quarterIndexOfDate(iso: string): number {
  const [y, m] = iso.split('-').map(Number);
  return y * 4 + Math.floor((m - 1) / 3);
}

export function rebaseTables(file: MockFile, opts: RebaseOptions): Tables {
  const delta = diffDays(opts.today, file.anchor_date);
  const nowOffsetMs = opts.loadNow.getTime() - Date.parse(file.anchor_now);
  const quarterShift = quarterIndexOfDate(opts.today) - quarterIndexOfDate(file.anchor_date);
  const r = file.rebase;
  const out: Tables = {};

  for (const [table, rows] of Object.entries(file.tables)) {
    const dateF = r.date_fields[table] ?? [];
    const instF = r.instant_fields[table] ?? [];
    const nowF = r.now_relative_fields[table] ?? [];
    const qF = r.quarter_fields[table] ?? [];
    const jsonF = r.json_fields[table] ?? [];
    out[table] = rows.map((row) => {
      const n: Row = { ...row };
      for (const f of dateF) if (typeof n[f] === 'string') n[f] = addDays(n[f], delta);
      for (const f of instF) if (typeof n[f] === 'string') n[f] = shiftInstant(n[f], delta);
      for (const f of nowF) {
        if (typeof n[f] === 'string') n[f] = new Date(Date.parse(n[f]) + nowOffsetMs).toISOString();
      }
      if (qF.length === 2 && n[qF[0]] != null && n[qF[1]] != null) {
        const s = shiftQuarter(n[qF[0]], n[qF[1]], quarterShift);
        n[qF[0]] = s.year;
        n[qF[1]] = s.quarter;
      }
      for (const f of jsonF) {
        if (typeof n[f] !== 'string') continue;
        try {
          const obj = JSON.parse(n[f]) as Row;
          if (obj && typeof obj === 'object') {
            for (const k of r.json_date_keys) if (typeof obj[k] === 'string') obj[k] = addDays(obj[k], delta);
            for (const k of r.json_instant_keys) if (typeof obj[k] === 'string') obj[k] = shiftInstant(obj[k], delta);
            n[f] = JSON.stringify(obj);
          }
        } catch {
          /* not JSON: leave untouched */
        }
      }
      return n;
    });
  }
  return out;
}

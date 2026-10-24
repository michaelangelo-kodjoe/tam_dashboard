// Overview "Upgrades, Next 30 Days" timeline: one marker per (date, polarity), colour is the only distinction.
import type { Upgrade30 } from '../types';
import { diffDays } from './dates';

export type Polarity = Upgrade30['polarity'];
export const WINDOW_DAYS = 30;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** West before East before DEV before unknown, so side-by-side markers always keep the same order. */
const ORDER: Record<string, number> = { West: 0, East: 1, DEV: 2, none: 3 };

/** "5 Nov" */
export const shortDate = (iso: string): string => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Accessible name and tooltip: "East PROD Upgrade, 5 Nov", "DEV Upgrade, 5 Nov", "PROD Upgrade, 5 Nov" (unknown polarity). */
export function markerLabel(polarity: Polarity, date: string): string {
  const who = polarity === 'East' ? 'East PROD' : polarity === 'West' ? 'West PROD' : polarity === 'DEV' ? 'DEV' : 'PROD';
  return `${who} Upgrade, ${shortDate(date)}`;
}
export const markerTone = (p: Polarity): 'west' | 'east' | 'dev' | 'unknown' => (p === 'West' ? 'west' : p === 'East' ? 'east' : p === 'DEV' ? 'dev' : 'unknown');

export interface Marker { key: string; polarity: Polarity; label: string }
export interface DateColumn { date: string; pct: number; markers: Marker[]; /** label row 0.. so close dates stagger instead of colliding */ row: number }

/** Collapse appliances to one marker per (date, polarity); columns are by date, ascending, inside today..today+30. */
export function buildColumns(items: Upgrade30[], today: string, minGapPct = 13): DateColumn[] {
  const byDate = new Map<string, Map<string, Marker>>();
  for (const u of items) {
    const d = diffDays(u.date, today);
    if (d < 0 || d > WINDOW_DAYS) continue;
    const m = byDate.get(u.date) ?? new Map<string, Marker>();
    const k = u.polarity ?? 'none';
    if (!m.has(k)) m.set(k, { key: `${u.date}|${k}`, polarity: u.polarity, label: markerLabel(u.polarity, u.date) });
    byDate.set(u.date, m);
  }
  const lastByRow: number[] = [];
  return [...byDate.keys()].sort().map((date) => {
    const pct = (diffDays(date, today) / WINDOW_DAYS) * 100;
    let row = 0;
    while (lastByRow[row] !== undefined && pct - lastByRow[row] < minGapPct) row++;
    lastByRow[row] = pct;
    const markers = [...byDate.get(date)!.entries()].sort((a, b) => ORDER[a[0]] - ORDER[b[0]]).map(([, v]) => v);
    return { date, pct, markers, row };
  });
}

/** "6 Servers · 4 PROD · 2 DEV" parts (no regions, no alerts). */
export const serverWord = (n: number): string => (n === 1 ? 'Server' : 'Servers');

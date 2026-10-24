// Pure maths for the BAMS trend chart: drag-to-zoom window, tick steps, severity line segments.
import type { Operator, Severity } from '../bamsTypes';

export const MIN_ZOOM_MS = 3 * 60_000;
export const MIN_DRAG_PX = 8;
export type Window = [number, number];

/**
 * Convert a drag between two pixel positions (relative to the plot area) into a time window.
 * Returns null for an accidental click (under 8 px) or a window under 3 minutes. Snapped to whole minutes
 * and clamped to the full range.
 */
export const MAX_ZOOM_MS = 7 * 24 * 3600_000;
/** Smallest window worth fetching: about two sample intervals, never under 3 minutes. */
export const minWindowMs = (intervalSeconds?: number | null): number => Math.max(MIN_ZOOM_MS, 2 * 1000 * (intervalSeconds ?? 60));

export function dragToWindow(x0: number, x1: number, plotW: number, view: Window, full: Window, opts: { maxMs?: number; minMs?: number } = {}): Window | null {
  if (plotW <= 0) return null;
  const a = Math.max(0, Math.min(plotW, Math.min(x0, x1)));
  const b = Math.max(0, Math.min(plotW, Math.max(x0, x1)));
  if (b - a < MIN_DRAG_PX) return null;
  const span = view[1] - view[0];
  const t0 = Math.round((view[0] + (a / plotW) * span) / 60_000) * 60_000;
  const t1 = Math.round((view[0] + (b / plotW) * span) / 60_000) * 60_000;
  const lo = Math.max(full[0], t0);
  let hi = Math.min(full[1], t1);
  if (hi - lo > (opts.maxMs ?? MAX_ZOOM_MS)) hi = lo + (opts.maxMs ?? MAX_ZOOM_MS); // the API serves at most 7 days
  if (hi - lo < (opts.minMs ?? MIN_ZOOM_MS)) return null;
  return [lo, hi];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const TICK_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

/** Smallest "nice" step that yields at most `max` ticks across the span. */
export function tickStep(span: number, max = 9): number {
  return TICK_STEPS.find((s) => span / s <= max) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/** Ticks at round local-time multiples of the step (finer as you zoom in). */
export function timeTicks(a: number, b: number, max = 9): number[] {
  if (!(b > a)) return [];
  const step = tickStep(b - a, max);
  const off = new Date(a).getTimezoneOffset() * MIN; // align to local midnight for day-scale steps
  const out: number[] = [];
  for (let t = Math.ceil((a - off) / step) * step + off; t <= b; t += step) out.push(t);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Tick label: time of day for sub-day steps, "14 Oct" for day steps, "14 Oct 09:00" when the window spans days but steps are sub-day. */
export function tickLabel(ts: number, span: number): string {
  const d = new Date(ts);
  const step = tickStep(span);
  if (step >= DAY) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return span > 36 * HOUR ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}` : hm;
}

/** "Zoomed: 14 Oct 09:12 to 09:48 (36 min)" style text. */
export function windowLabel(w: Window, full: Window): string {
  const f = (t: number) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const mins = Math.round((w[1] - w[0]) / MIN);
  const dur = mins >= 1440 ? `${Math.round(mins / 144) / 10} d` : mins >= 120 ? `${Math.round(mins / 6) / 10} h` : `${mins} min`;
  const zoomed = w[0] !== full[0] || w[1] !== full[1];
  return `${zoomed ? 'Zoomed' : 'Showing'}: ${f(w[0])} to ${f(w[1])} (${dur})`;
}

// ------------------------------------------------------------------ severity colouring

export type Band = 'n' | 'w' | 'c';
export interface Level { value: number; below: boolean }
export interface Levels { warn: Level | null; crit: Level | null }

/** Warning/Critical levels from the rule lines (direction from the rule operator; default is "above"). */
export function severityLevels(lines: { rule_id: string; value: number; severity: Severity }[], rules: { id: string; operator: Operator }[] = []): Levels {
  const op = new Map(rules.map((r) => [r.id, r.operator]));
  const pick = (sev: Severity): Level | null => {
    const ls = lines.filter((l) => l.severity === sev).map((l) => ({ value: l.value, below: (op.get(l.rule_id) ?? '>').startsWith('<') }));
    if (!ls.length) return null;
    const below = ls[0].below;
    const same = ls.filter((l) => l.below === below).map((l) => l.value);
    return { value: below ? Math.max(...same) : Math.min(...same), below }; // most inclusive level
  };
  return { warn: pick('Warning'), crit: pick('Critical') };
}

const reached = (v: number, l: Level | null) => l != null && (l.below ? v <= l.value : v >= l.value);
export function bandOf(v: number, lv: Levels): Band {
  return reached(v, lv.crit) ? 'c' : reached(v, lv.warn) ? 'w' : 'n';
}

/**
 * Split a series into three overlaid series (normal / warning / critical). Each segment takes the band of its
 * earlier point and shares its end point with the next, so the coloured runs join without gaps.
 */
export function severitySegments(values: number[], lv: Levels): Record<Band, (number | null)[]> {
  const bands = values.map((v) => bandOf(v, lv));
  const out: Record<Band, (number | null)[]> = { n: [], w: [], c: [] };
  values.forEach((v, i) => {
    (['n', 'w', 'c'] as Band[]).forEach((b) => out[b].push(bands[i] === b || (i > 0 && bands[i - 1] === b) ? v : null));
  });
  return out;
}

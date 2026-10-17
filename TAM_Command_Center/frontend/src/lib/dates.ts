// Date helpers. All-day fields are plain YYYY-MM-DD strings with no timezone (D-06);
// date maths is done on UTC midnight so it never shifts across DST or zones.

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function toDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The workstation's local calendar date as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function addDays(iso: string, n: number): string {
  return toDateString(new Date(parseDate(iso).getTime() + n * DAY_MS));
}

/** a - b in whole days */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / DAY_MS);
}

export function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toDateString(parseDate(s)) === s;
}

/** Local calendar date (YYYY-MM-DD) of an ISO instant, in the browser's timezone (D-06). */
export function instantLocalDate(instant: string): string {
  const d = parseInstant(instant);
  return localToday(d);
}

/** `12 Oct` in the current year, otherwise `03 Jan 2027`. */
export function formatDate(iso: string | null | undefined, today: string): string {
  if (!iso) return '';
  const d = parseDate(iso);
  const base = `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === parseDate(today).getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

/** `Mon 12 Oct` (Today and Upcoming headings). */
export function formatDateLong(iso: string): string {
  const d = parseDate(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** Legacy server setting (`local` | `gmt`). Timestamps are ALWAYS shown in the browser's local time zone; `gmt` is ignored. */
export type TimeDisplay = 'local' | 'gmt';

// ---- 12 / 24 hour clock (user preference, default 12-hour am/pm) ------------------------------
export type TimeFormat = '12h' | '24h';
const FMT_KEY = 'tam.timeFormat';
let timeFormat: TimeFormat = (() => { try { return localStorage.getItem(FMT_KEY) === '24h' ? '24h' : '12h'; } catch { return '12h'; } })();
const listeners = new Set<() => void>();
export function getTimeFormat(): TimeFormat { return timeFormat; }
export function setTimeFormat(f: TimeFormat): void {
  timeFormat = f;
  try { localStorage.setItem(FMT_KEY, f); } catch { /* not remembered */ }
  listeners.forEach((l) => l());
}
export function subscribeTimeFormat(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

/** Server instants are UTC. A string without a zone ("2026-10-16 13:30:00" or "...T13:30:00") is treated as UTC. */
export function parseInstant(s: string): Date {
  const v = s.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v);
  return new Date(naive ? `${v.replace(' ', 'T')}Z` : v);
}

/** `9:30 AM` or `09:30` (local), optionally with seconds. */
export function timeOfDay(d: Date, seconds = false, fmt: TimeFormat = timeFormat): string {
  const h = d.getHours();
  const mm = pad2(d.getMinutes());
  const ss = seconds ? `:${pad2(d.getSeconds())}` : '';
  if (fmt === '24h') return `${pad2(h)}:${mm}${ss}`;
  return `${h % 12 || 12}:${mm}${ss} ${h < 12 ? 'AM' : 'PM'}`;
}

/** `12 Oct 2:05 PM` in the user's local time zone (`12 Oct 14:05` in 24-hour mode). Second argument kept for old callers; ignored. */
export function formatTimestamp(instant: string, _tz?: TimeDisplay, withYearIfOld?: string): string {
  const d = parseInstant(instant);
  if (Number.isNaN(d.getTime())) return '';
  const showYear = withYearIfOld ? d.getFullYear() !== parseDate(withYearIfOld).getUTCFullYear() : false;
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()]}${showYear ? ' ' + d.getFullYear() : ''} ${timeOfDay(d)}`;
}

export function formatClock(now: Date, _tz?: TimeDisplay): string {
  return `${timeOfDay(now)} Local`;
}

/** Relative label from days_delta (future positive). Always shown next to the absolute date. */
export function relativeLabel(delta: number | null): { text: string; overdue: boolean; today: boolean } {
  if (delta === null) return { text: '', overdue: false, today: false };
  if (delta === 0) return { text: 'Today', overdue: false, today: true };
  if (delta === 1) return { text: 'Tomorrow', overdue: false, today: false };
  if (delta === -1) return { text: '1d overdue', overdue: true, today: false };
  if (delta > 0) return { text: `in ${delta}d`, overdue: false, today: false };
  return { text: `${-delta}d overdue`, overdue: true, today: false };
}

/** For past-tense things (last contact, updated): `5d ago`. */
export function agoLabel(delta: number): string {
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta > 0) return `in ${delta}d`;
  if (delta === -1) return 'Yesterday';
  return `${-delta}d ago`;
}

export function dayHeading(iso: string, today: string): string {
  const delta = diffDays(iso, today);
  if (delta === 0) return 'TODAY';
  if (delta === -1) return 'YESTERDAY';
  if (delta === 1) return 'TOMORROW';
  return formatDateLong(iso).toUpperCase();
}

export function nowInstant(): string {
  return new Date().toISOString();
}

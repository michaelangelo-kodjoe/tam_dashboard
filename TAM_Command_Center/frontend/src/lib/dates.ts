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
  const d = new Date(instant);
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

export type TimeDisplay = 'local' | 'gmt';

/** `12 Oct 14:05` local, or `12 Oct 18:05 GMT`. 24-hour clock. */
export function formatTimestamp(instant: string, tz: TimeDisplay = 'local', withYearIfOld?: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  const gmt = tz === 'gmt';
  const day = gmt ? d.getUTCDate() : d.getDate();
  const mon = gmt ? d.getUTCMonth() : d.getMonth();
  const yr = gmt ? d.getUTCFullYear() : d.getFullYear();
  const hh = gmt ? d.getUTCHours() : d.getHours();
  const mm = gmt ? d.getUTCMinutes() : d.getMinutes();
  const showYear = withYearIfOld ? yr !== parseDate(withYearIfOld).getUTCFullYear() : false;
  return `${pad2(day)} ${MONTHS[mon]}${showYear ? ' ' + yr : ''} ${pad2(hh)}:${pad2(mm)}${gmt ? ' GMT' : ''}`;
}

export function formatClock(now: Date, tz: TimeDisplay): string {
  const hh = tz === 'gmt' ? now.getUTCHours() : now.getHours();
  const mm = tz === 'gmt' ? now.getUTCMinutes() : now.getMinutes();
  return `${pad2(hh)}:${pad2(mm)}${tz === 'gmt' ? ' GMT' : ' Local'}`;
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

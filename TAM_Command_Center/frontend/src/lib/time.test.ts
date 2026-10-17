// One shared local-time formatter: UTC instants -> local time, 12-hour am/pm by default, date-only values never shift.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { formatClock, formatDate, formatTimestamp, instantLocalDate, parseInstant, setTimeFormat, timeOfDay } from './dates';
import { formatStamp, formatTime } from './bams';

const OLD = process.env.TZ;
const tz = (z: string) => { process.env.TZ = z; };
beforeEach(() => { tz('America/New_York'); setTimeFormat('12h'); });
afterAll(() => { if (OLD === undefined) delete process.env.TZ; else process.env.TZ = OLD; setTimeFormat('12h'); });

describe('UTC to local', () => {
  it('converts a UTC instant to the local zone (New York, EDT) in 12-hour am/pm', () => {
    expect(formatTimestamp('2026-10-16T13:30:00.000Z')).toBe('16 Oct 9:30 AM');
    expect(formatTimestamp('2026-10-16T22:05:00.000Z')).toBe('16 Oct 6:05 PM');
  });
  it('crosses midnight into the previous local day', () => {
    expect(formatTimestamp('2026-10-17T03:15:00.000Z')).toBe('16 Oct 11:15 PM');
    expect(instantLocalDate('2026-10-17T03:15:00.000Z')).toBe('2026-10-16');
  });
  it('noon and midnight read 12 PM and 12 AM', () => {
    expect(timeOfDay(new Date(2026, 9, 16, 12, 0))).toBe('12:00 PM');
    expect(timeOfDay(new Date(2026, 9, 16, 0, 5))).toBe('12:05 AM');
  });
  it('follows other zones, including half-hour offsets', () => {
    tz('Asia/Kolkata');
    expect(formatTimestamp('2026-10-16T13:30:00.000Z')).toBe('16 Oct 7:00 PM');
    tz('Pacific/Auckland');
    expect(formatTimestamp('2026-10-16T13:30:00.000Z')).toBe('17 Oct 2:30 AM');
  });
  it('a server string without a zone is UTC', () => {
    expect(parseInstant('2026-10-16 13:30:00').toISOString()).toBe('2026-10-16T13:30:00.000Z');
    expect(parseInstant('2026-10-16T13:30:00').toISOString()).toBe('2026-10-16T13:30:00.000Z');
    expect(parseInstant('2026-10-16T13:30:00.250Z').toISOString()).toBe('2026-10-16T13:30:00.250Z');
    expect(parseInstant('2026-10-16T09:30:00-04:00').toISOString()).toBe('2026-10-16T13:30:00.000Z');
    expect(formatTimestamp('2026-10-16 13:30:00')).toBe('16 Oct 9:30 AM');
  });
  it('never prints GMT or UTC, whatever the legacy setting says', () => {
    expect(formatTimestamp('2026-10-16T13:30:00.000Z', 'gmt')).toBe('16 Oct 9:30 AM');
    expect(formatClock(new Date(2026, 9, 16, 15, 4), 'gmt')).toBe('3:04 PM Local');
  });
  it('shows the year only when asked and different', () => {
    expect(formatTimestamp('2027-01-03T15:00:00.000Z', 'local', '2026-10-16')).toBe('03 Jan 2027 10:00 AM');
  });
});

describe('24-hour mode', () => {
  it('uses 24-hour local time everywhere', () => {
    setTimeFormat('24h');
    expect(formatTimestamp('2026-10-16T13:30:00.000Z')).toBe('16 Oct 09:30');
    expect(formatTimestamp('2026-10-16T22:05:00.000Z')).toBe('16 Oct 18:05');
    expect(formatClock(new Date(2026, 9, 16, 15, 4))).toBe('15:04 Local');
    expect(formatTime('2026-10-16T22:05:09.000Z', 'local', true)).toBe('18:05:09');
    expect(formatStamp('2026-10-16T22:05:09.000Z')).toBe('16 Oct 18:05');
  });
});

describe('BAMS formatters share the same rules', () => {
  it('12-hour local, seconds optional, never for empty values', () => {
    expect(formatTime('2026-10-16T22:05:09.000Z')).toBe('6:05 PM');
    expect(formatTime('2026-10-16T22:05:09.000Z', 'local', true)).toBe('6:05:09 PM');
    expect(formatStamp('2026-10-16T22:05:09.000Z')).toBe('16 Oct 6:05 PM');
    expect(formatTime(null)).toBe('never');
  });
});

describe('date-only values never shift', () => {
  it.each(['America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata', 'UTC'])('due date 2026-10-16 stays 16 Oct in %s', (z) => {
    tz(z);
    expect(formatDate('2026-10-16', '2026-10-16')).toBe('16 Oct');
    expect(formatDate('2026-01-01', '2026-10-16')).toBe('01 Jan');
  });
});

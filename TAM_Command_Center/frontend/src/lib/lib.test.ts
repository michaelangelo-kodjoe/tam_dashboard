import { describe, expect, it } from 'vitest';
import { addDays, dayHeading, diffDays, formatDate, formatDateLong, formatTimestamp, isISODate, relativeLabel } from './dates';
import { clean, validateAccount, validateContact, validateNote, validateTask } from './validate';
import { topOpenTasks } from './tasks';
import { accountPath, queueTarget, withoutParam } from './links';
import type { QueueItem, Task } from '../types';

describe('dates', () => {
  it('does date maths without timezone drift across DST boundaries', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-11-02', '2026-10-31')).toBe(2);
    expect(isISODate('2026-02-30')).toBe(false);
    expect(isISODate('2026-02-28')).toBe(true);
  });
  it('formats per guidelines §13', () => {
    expect(formatDate('2026-10-12', '2026-10-12')).toBe('12 Oct');
    expect(formatDate('2027-01-03', '2026-10-12')).toBe('03 Jan 2027');
    expect(formatDateLong('2026-10-12')).toBe('Mon 12 Oct');
    expect(formatTimestamp('2026-10-12T18:05:00.000Z', 'gmt')).not.toMatch(/GMT|UTC/); // always local
    expect(dayHeading('2026-10-12', '2026-10-12')).toBe('TODAY');
    expect(dayHeading('2026-10-11', '2026-10-12')).toBe('YESTERDAY');
    expect(dayHeading('2026-10-09', '2026-10-12')).toBe('FRI 09 OCT');
  });
  it('relative labels', () => {
    expect(relativeLabel(0).text).toBe('Today');
    expect(relativeLabel(1).text).toBe('Tomorrow');
    expect(relativeLabel(3).text).toBe('in 3d');
    expect(relativeLabel(-3)).toEqual({ text: '3d overdue', overdue: true, today: false });
    expect(relativeLabel(null).text).toBe('');
  });
});

describe('validation mirrors the server rules', () => {
  const base = { task: 'x', client_id: null, category: 'Other', priority: 'Low', due: null, next_update: null, status: 'Not Started', waiting: null, notes: null } as const;
  it('task', () => {
    expect(validateTask({ ...base } as never)).toEqual({});
    expect(validateTask({ ...base, task: '  ' } as never)).toHaveProperty('task');
    expect(validateTask({ ...base, task: 'x'.repeat(501) } as never)).toHaveProperty('task');
    expect(validateTask({ ...base, category: 'Nope' } as never)).toHaveProperty('category');
    expect(validateTask({ ...base, due: '2026-99-99' } as never)).toHaveProperty('due');
    expect(validateTask({ ...base, notes: 'n'.repeat(20001) } as never)).toHaveProperty('notes');
  });
  it('note needs subject or body; limits apply', () => {
    const n = { client_id: 'c', note_type: 'Call Note', timestamp: '2026-10-12T10:00:00.000Z', subject: null, body: null, action_items: null } as const;
    expect(validateNote({ ...n } as never)).toHaveProperty('subject');
    expect(validateNote({ ...n, subject: 's' } as never)).toEqual({});
    expect(validateNote({ ...n, body: 'b'.repeat(50001) } as never)).toHaveProperty('body');
    expect(validateNote({ ...n, subject: 's', client_id: '' } as never)).toHaveProperty('client_id');
  });
  it('contact email and account name', () => {
    expect(validateContact({ client_id: 'c', name: 'A', role: null, team: null, email: 'a@b', is_primary: false })).toHaveProperty('email');
    expect(validateContact({ client_id: 'c', name: 'A', role: null, team: null, email: 'a@b.co', is_primary: false })).toEqual({});
    expect(validateAccount({ name: '', bpid: null, products: null, status: 'Active', next_contact: null, notes: null })).toHaveProperty('name');
    expect(clean('  hi ')).toBe('hi');
    expect(clean('   ')).toBeNull();
  });
});

describe('overview task ordering', () => {
  const T = '2026-10-12';
  const mk = (id: string, priority: Task['priority'], due: string | null, status: Task['status'] = 'Not Started', archived = false): Task => ({
    id, task: id, client_id: 'c', category: 'Other', priority, due, next_update: null, status, waiting: null, notes: null, archived, created_at: '', updated_at: '', row_version: 1,
  });
  it('overdue first, then priority High->Low, then due ascending with nulls last; excludes Complete and archived; caps at 8', () => {
    const tasks = [
      mk('upLow', 'Low', '2026-10-13'), mk('upHigh', 'High', '2026-10-20'), mk('noDueHigh', 'High', null), mk('odLow', 'Low', '2026-10-01'),
      mk('odHigh', 'High', '2026-10-10'), mk('odHighOlder', 'High', '2026-10-05'), mk('done', 'High', '2026-10-01', 'Complete'), mk('arch', 'High', '2026-10-01', 'Not Started', true),
    ];
    expect(topOpenTasks(tasks, T).map((t) => t.id)).toEqual(['odHighOlder', 'odHigh', 'odLow', 'upHigh', 'noDueHigh', 'upLow']);
    const many = Array.from({ length: 12 }, (_, i) => mk(`t${i}`, 'Medium', `2026-11-${String(i + 1).padStart(2, '0')}`));
    expect(topOpenTasks(many, T)).toHaveLength(8);
  });
});

describe('links', () => {
  const base: QueueItem = { kind: 'task', id: 'i', tier: 1, tier_label: null, client_id: 'c1', client_name: 'A', type_label: 'Task', title: 't', status: 's', priority: 'High', severity: null, urgency: 'overdue', date: null, date_kind: null, days_delta: null, context: null, server_name: null };
  it('queue targets follow PM §4.2', () => {
    expect(queueTarget(base)).toBe('/accounts/c1/tasks?task=i');
    expect(queueTarget({ ...base, client_id: null })).toBe('/tasks?task=i');
    expect(queueTarget({ ...base, kind: 'client_follow_up' })).toBe('/accounts/c1/overview#next-touch');
    expect(queueTarget({ ...base, kind: 'bams_alert', server_name: 'srv-1' })).toBe('/bams/alerts?event=i');
    expect(queueTarget({ ...base, kind: 'server_upgrade', server_name: 'a b' })).toBe('/accounts/c1/infrastructure?server=a+b');
  });
  it('helpers', () => {
    expect(accountPath('x')).toBe('/accounts/x/overview');
    expect(withoutParam('?task=1&server=a', 'task')).toBe('?server=a');
    expect(withoutParam('?task=1', 'task')).toBe('');
  });
});

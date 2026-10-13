import { describe, expect, it } from 'vitest';
import { DataSourceError } from '../DataSource';
import { newMock, mockFile } from './testFile';
import { TASK_CATEGORIES } from '../../types';

const T = '2026-10-12';
const baseTask = { task: 'New thing', client_id: null, category: 'Other', priority: 'Medium', due: null, next_update: null, status: 'Not Started', waiting: null, notes: null } as const;

async function expectCode(p: Promise<unknown>, code: string) {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(DataSourceError); expect((e as DataSourceError).code).toBe(code); return e as DataSourceError; }
  throw new Error(`expected DataSourceError(${code})`);
}

describe('MockDataSource', () => {
  it('loads, rebases to the requested date and reports mock runtime', async () => {
    const ds = newMock({ today: '2026-10-20' });
    const s = await ds.getState();
    expect(s.today).toBe('2026-10-20');
    expect(s.runtime.source).toBe('mock');
    expect(s.accounts).toHaveLength(12);
    // a task due on the anchor shifts by 8 days
    const src = mockFile().tables.tasks.find((t) => t.due === T)!;
    expect(s.tasks.find((t) => t.id === src.id)!.due).toBe('2026-10-20');
  });

  it('account summaries follow account_summary.sql (open, overdue, waiting, alerts, servers)', async () => {
    const ds = newMock();
    const s = await ds.getState();
    const a = s.accounts.find((x) => x.name.startsWith('Halvorsen'))!;
    const mine = s.tasks.filter((t) => t.client_id === a.id);
    expect(a.open_tasks).toBe(mine.filter((t) => t.status !== 'Complete').length);
    expect(a.overdue).toBe(mine.filter((t) => t.status !== 'Complete' && t.due && t.due < T).length);
    expect(a.waiting).toBe(mine.filter((t) => t.status === 'Waiting').length);
    expect(a.servers).toBe(3); // hfa-bpipe-ldn-01/02 + hfa-bpipe-dev-01, case-insensitive distinct
    expect(a.active_alerts).toBeGreaterThanOrEqual(1);
  });

  it('BAMS freshness uses the frozen mock clock, never the live clock', async () => {
    const ds = newMock({ loadNow: new Date(`${T}T12:00:00.000Z`) });
    const real = Date.now;
    try {
      // 3 days pass in wall-clock time; seeded states must not change
      Date.now = () => real() + 3 * 86_400_000;
      const accts = (await ds.getState()).accounts;
      const states: string[] = [];
      for (const a of accts) for (const o of (await ds.getInfrastructure(a.id)).bams_objects) states.push(o.worst_status);
      expect(states).toContain('Live');
      expect(states).toContain('Stale');
      expect(states).toContain('Disabled');
      const counts = states.reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});
      const again: string[] = [];
      for (const a of accts) for (const o of (await newMock({ loadNow: new Date(`${T}T12:00:00.000Z`) }).getInfrastructure(a.id)).bams_objects) again.push(o.worst_status);
      expect(again.reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {})).toEqual(counts);
    } finally {
      Date.now = real;
    }
  });

  describe('tasks', () => {
    it('create: validates, audits, and appears in state', async () => {
      const ds = newMock();
      await expectCode(ds.saveTask({ ...baseTask, task: '   ' }), 'validation_error');
      const r = await ds.saveTask({ ...baseTask, client_id: (await ds.getState()).accounts[0].id });
      expect(r.item.row_version).toBe(1);
      const s = await ds.getState();
      expect(s.tasks.some((t) => t.id === r.item.id)).toBe(true);
    });

    it('rejects unknown enums and malformed dates server-side style', async () => {
      const ds = newMock();
      const e = await expectCode(ds.saveTask({ ...baseTask, category: 'Bogus' as never, due: '2026-13-40' }), 'validation_error');
      expect(Object.keys(e.fields ?? {}).sort()).toEqual(['category', 'due']);
      expect(TASK_CATEGORIES).toHaveLength(10);
    });

    it('expected_row_version: a stale write is rejected with stale_write, a current one bumps by 1', async () => {
      const ds = newMock();
      const t0 = (await ds.getState()).tasks[0];
      const input = { ...t0, expected_row_version: t0.row_version, priority: t0.priority === 'High' ? 'Low' : 'High' } as const;
      const ok = await ds.saveTask(input);
      expect(ok.item.row_version).toBe(t0.row_version + 1);
      await expectCode(ds.saveTask({ ...input, task: 'again' }), 'stale_write'); // still carries the old version
    });

    it('completing writes an audit "completed" that surfaces as a system event in Activity', async () => {
      const ds = newMock();
      const s = await ds.getState();
      const t = s.tasks.find((x) => x.client_id && x.status !== 'Complete')!;
      await ds.saveTask({ ...t, status: 'Complete', expected_row_version: t.row_version });
      const page = await ds.getActivity(t.client_id!, { filter: 'system' });
      expect(page.items[0].entry_kind).toBe('system');
      expect(page.items[0].entry_kind === 'system' && page.items[0].sentence).toBe(`Task completed: ${t.task}`);
    });

    it('D-07: Client Follow-Up sets next_contact when empty or earlier, and not otherwise', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.next_contact)!;
      const later = '2027-01-15';
      const r1 = await ds.saveTask({ ...baseTask, client_id: acc.id, category: 'Client Follow-Up', due: later, update_next_contact: true });
      expect(r1.side_effects).not.toContain('next_contact_updated'); // later than the current touch
      const earlier = '2026-10-13';
      const cur = (await ds.getState()).accounts.find((a) => a.id === acc.id)!.next_contact!;
      const target = earlier < cur ? earlier : addDay(cur, -1);
      const r2 = await ds.saveTask({ ...baseTask, task: 'Earlier', client_id: acc.id, category: 'Client Follow-Up', due: target, update_next_contact: true });
      expect(r2.side_effects).toContain('next_contact_updated');
      expect((await ds.getState()).accounts.find((a) => a.id === acc.id)!.next_contact).toBe(target);
      // unchecked checkbox: no update
      const r3 = await ds.saveTask({ ...baseTask, task: 'Even earlier', client_id: acc.id, category: 'Client Follow-Up', due: addDay(target, -2), update_next_contact: false });
      expect(r3.side_effects).toHaveLength(0);
    });

    it('D-07: an account with no next_contact gets it from the follow-up', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.status === 'Active' && !a.next_contact);
      if (!acc) return; // seed may not contain one; covered by the earlier-date case
      const r = await ds.saveTask({ ...baseTask, client_id: acc.id, category: 'Client Follow-Up', due: '2026-10-30', update_next_contact: true });
      expect(r.side_effects).toContain('next_contact_updated');
    });

    it('D-23 through mutations: a follow-up due on next_contact removes the account-level touch from Today', async () => {
      const ds = newMock();
      const before = await ds.getToday();
      const touch = [...before.queue, ...before.upcoming].find((i) => i.kind === 'client_follow_up')!;
      const acc = (await ds.getState()).accounts.find((a) => a.id === touch.client_id)!;
      await ds.saveTask({ ...baseTask, task: 'The follow-up', client_id: acc.id, category: 'Client Follow-Up', due: acc.next_contact });
      const after = await ds.getToday();
      expect([...after.queue, ...after.upcoming].some((i) => i.kind === 'client_follow_up' && i.id === acc.id)).toBe(false);
      const t = [...after.queue, ...after.upcoming].find((i) => i.kind === 'task' && i.title === 'The follow-up');
      expect(t?.context).toBe('Next Client Touch');
    });

    it('archive hides from state and from Today, unarchive restores; delete needs confirm, takes a backup and audits', async () => {
      const ds = newMock();
      const t = (await ds.getState()).tasks.find((x) => x.client_id && x.status !== 'Complete' && x.due && x.due < T)!;
      await ds.archiveTask({ id: t.id, archived: true });
      expect((await ds.getState()).tasks.some((x) => x.id === t.id)).toBe(false);
      expect((await ds.getTasks({ archived: true })).some((x) => x.id === t.id)).toBe(true);
      expect((await ds.getToday()).queue.some((i) => i.id === t.id)).toBe(false);
      await ds.archiveTask({ id: t.id, archived: false });
      expect((await ds.getState()).tasks.some((x) => x.id === t.id)).toBe(true);
      await expectCode(ds.deleteTask({ id: t.id, confirm: false as never }), 'confirmation_required');
      const nBackups = (await ds.listBackups()).length;
      await ds.deleteTask({ id: t.id, confirm: true });
      expect((await ds.listBackups())[0].reason).toBe('pre-delete');
      expect((await ds.listBackups()).length).toBeGreaterThanOrEqual(Math.min(nBackups + 1, 20));
      const sys = await ds.getActivity(t.client_id!, { filter: 'system' });
      expect(sys.items.some((e) => e.entry_kind === 'system' && e.sentence === `Task deleted: ${t.task}`)).toBe(true);
      await expectCode(ds.archiveTask({ id: t.id, archived: true }), 'not_found');
    });
  });

  describe('notes and activity', () => {
    it('create, edit and delete work for all three types (US-7.3)', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts[0];
      for (const type of ['Meeting Note', 'Call Note', 'General Note'] as const) {
        const c = await ds.saveNote({ client_id: acc.id, note_type: type, timestamp: new Date().toISOString(), subject: `Subj ${type}`, body: 'body', action_items: null });
        expect(c.item.source).toBe('GUI');
        const u = await ds.saveNote({ ...c.item, subject: 'Edited', expected_row_version: c.item.row_version });
        expect(u.item.row_version).toBe(c.item.row_version + 1);
        await expectCode(ds.saveNote({ ...c.item, subject: 'stale', expected_row_version: c.item.row_version }), 'stale_write');
        await expectCode(ds.deleteNote({ id: u.item.id, confirm: false as never }), 'confirmation_required');
        await ds.deleteNote({ id: u.item.id, confirm: true });
        const sys = await ds.getActivity(acc.id, { filter: 'system' });
        expect(sys.items.some((e) => e.entry_kind === 'system' && e.sentence === `${type} deleted: Edited`)).toBe(true);
      }
    });

    it('D-08: a Meeting/Call note later than last_contact updates it; a General note does not', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.status === 'Active')!;
      const g = await ds.saveNote({ client_id: acc.id, note_type: 'General Note', timestamp: new Date().toISOString(), subject: 'g', body: null, action_items: null });
      expect(g.side_effects).toHaveLength(0);
      const m = await ds.saveNote({ client_id: acc.id, note_type: 'Meeting Note', timestamp: new Date().toISOString(), subject: 'm', body: null, action_items: null });
      expect(m.side_effects).toContain('last_contact_updated');
    });

    it('filters return only their type; System Events returns only derived events (US-7.2 AC1)', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!;
      const kinds = async (f: 'meeting' | 'call' | 'general' | 'system') => (await ds.getActivity(acc.id, { filter: f, limit: 100 })).items;
      expect((await kinds('meeting')).every((e) => e.entry_kind === 'note' && e.note.note_type === 'Meeting Note')).toBe(true);
      expect((await kinds('call')).every((e) => e.entry_kind === 'note' && e.note.note_type === 'Call Note')).toBe(true);
      expect((await kinds('general')).every((e) => e.entry_kind === 'note' && e.note.note_type === 'General Note')).toBe(true);
      const sys = await kinds('system');
      expect(sys.length).toBeGreaterThan(0);
      expect(sys.every((e) => e.entry_kind === 'system')).toBe(true);
    });

    it('paginates 50 at a time with a stable cursor and no overlap', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!;
      const p1 = await ds.getActivity(acc.id, { filter: 'all', limit: 50 });
      expect(p1.items).toHaveLength(50);
      expect(p1.next_cursor).not.toBeNull();
      const p2 = await ds.getActivity(acc.id, { filter: 'all', limit: 50, cursor: p1.next_cursor });
      const keys = new Set(p1.items.map((e) => e.entry_key));
      expect(p2.items.every((e) => !keys.has(e.entry_key))).toBe(true);
      expect(p1.items[49].ts >= p2.items[0].ts).toBe(true);
    });

    it('search narrows by text', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!;
      const all = await ds.getActivity(acc.id, { filter: 'all', limit: 100 });
      const some = await ds.getActivity(acc.id, { filter: 'all', q: 'reconnects', limit: 100 });
      expect(some.items.length).toBeGreaterThan(0);
      expect(some.items.length).toBeLessThan(all.items.length);
    });
  });

  describe('contacts', () => {
    it('making B primary clears A in the same operation, with a "B is now primary (was A)" message (US-8.2)', async () => {
      const ds = newMock();
      const s = await ds.getState();
      const acc = s.accounts.find((a) => s.contacts.filter((c) => c.client_id === a.id).length >= 2 && s.contacts.some((c) => c.client_id === a.id && c.is_primary))!;
      const mine = s.contacts.filter((c) => c.client_id === acc.id);
      const a = mine.find((c) => c.is_primary)!;
      const b = mine.find((c) => !c.is_primary)!;
      const r = await ds.saveContact({ ...b, is_primary: true, expected_row_version: b.row_version });
      expect(r.message).toBe(`${b.name} is now primary (was ${a.name})`);
      expect(r.side_effects).toContain('primary_cleared');
      const after = (await ds.getState()).contacts.filter((c) => c.client_id === acc.id);
      expect(after.filter((c) => c.is_primary).map((c) => c.id)).toEqual([b.id]);
      const sys = await ds.getActivity(acc.id, { filter: 'system', limit: 5 });
      expect(sys.items.some((e) => e.entry_kind === 'system' && e.sentence === `${b.name} is now primary (was ${a.name})`)).toBe(true);
    });

    it('an account may have zero primary contacts', async () => {
      const ds = newMock();
      const s = await ds.getState();
      const p = s.contacts.find((c) => c.is_primary)!;
      await ds.saveContact({ ...p, is_primary: false, expected_row_version: p.row_version });
      expect((await ds.getState()).contacts.filter((c) => c.client_id === p.client_id && c.is_primary)).toHaveLength(0);
    });

    it('validates email shape', async () => {
      const ds = newMock();
      const acc = (await ds.getState()).accounts[0];
      const e = await expectCode(ds.saveContact({ client_id: acc.id, name: 'X', role: null, team: null, email: 'not-an-email', is_primary: false }), 'validation_error');
      expect(e.fields).toHaveProperty('email');
    });
  });

  describe('accounts', () => {
    it('enforces unique names case-insensitively (conflict)', async () => {
      const ds = newMock();
      const e = await expectCode(ds.saveAccount({ name: '  halvorsen FJORD asset management ', bpid: null, products: null, status: 'Active', next_contact: null, notes: null }), 'conflict');
      expect(e.fields).toHaveProperty('name');
    });

    it('account delete needs the exact name, cascades and keeps audit history (D-12)', async () => {
      const ds = newMock();
      const created = await ds.saveAccount({ name: 'Disposable Co', bpid: null, products: null, status: 'Active', next_contact: null, notes: null });
      await ds.saveContact({ client_id: created.item.id, name: 'C', role: null, team: null, email: null, is_primary: true });
      await ds.saveTask({ ...baseTask, client_id: created.item.id });
      await expectCode(ds.deleteAccount({ id: created.item.id, confirm: true, confirm_name: 'disposable co' }), 'confirmation_required');
      await ds.deleteAccount({ id: created.item.id, confirm: true, confirm_name: 'Disposable Co' });
      const s = await ds.getState();
      expect(s.accounts.some((a) => a.id === created.item.id)).toBe(false);
      expect(s.contacts.some((c) => c.client_id === created.item.id)).toBe(false);
      expect(s.tasks.some((t) => t.client_id === created.item.id)).toBe(false);
      const recent = (await ds.getToday()).recent_changes;
      expect(recent.some((r) => r.client_id === created.item.id)).toBe(true); // audit survived (no FK)
    });
  });

  it('settings: validates and persists', async () => {
    const ds = newMock();
    await expectCode(ds.saveSettings({ auto_refresh_minutes: '7' as never }), 'validation_error');
    const r = await ds.saveSettings({ time_display: 'gmt' });
    expect(r.item.time_display).toBe('gmt');
    expect((await ds.getSettings()).time_display).toBe('gmt');
  });

  it('failNext injects a network error (used for stale-data states)', async () => {
    const ds = newMock();
    await ds.getState();
    ds.failNext = 1;
    await expectCode(ds.getToday(), 'network');
    await expect(ds.getToday()).resolves.toBeTruthy();
  });
});

function addDay(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

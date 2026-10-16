import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { newMock } from './data/mock/testFile';
import { taskToInput } from './lib/tasks';

function go(path: string) {
  window.history.pushState({}, '', path);
}
async function boot(path: string, ds = newMock()) {
  go(path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { user, ds };
}
const loc = () => window.location.pathname + window.location.search;

beforeEach(() => { document.body.style.overflow = ''; });
afterEach(() => cleanup());

const utcMidnight = (day: string) => `${day}T00:00:00.000Z`;
const options = (c: HTMLElement = document.body) => within(c).getAllByRole('option');
const chip = (name: RegExp) => screen.getByRole('radio', { name });

describe('app shell and Today: Triage Split (D-26..D-30, US-3.6..US-3.9)', () => {
  it('lands on Today with the top 10, eight chips with full counts, a detail pane and collapsed Later tabs', async () => {
    const ds = newMock();
    const full = await ds.getToday();
    await boot('/', ds);
    expect(await screen.findByRole('heading', { level: 1, name: /Today/ })).toBeInTheDocument();
    expect(loc()).toBe('/today');
    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('Mock data')).toBeInTheDocument();
    const list = await screen.findByRole('listbox', { name: /Work queue/ });
    const opts = options(list);
    expect(opts).toHaveLength(10); // strict top 10 (AC1)
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(list).toHaveAttribute('aria-activedescendant', opts[0].id);
    expect(opts.map((o) => o.querySelector('.trow__n')!.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // titles equal the first 10 of the queue array, in queue order (AC6)
    expect(opts.map((o) => o.querySelector('b')!.textContent)).toEqual(full.queue.slice(0, 10).map((i) => i.title));
    // chips: Top 10, six tiers, All; counts are the full counts (AC3)
    const radios = within(screen.getByRole('radiogroup', { name: 'Queue groups' })).getAllByRole('radio');
    expect(radios.map((r) => r.querySelector('.chip__label')!.textContent)).toEqual(['Top 10', 'Overdue / critical', 'Due today', 'Alerts', 'Waiting', 'Upgrades', 'Next 3 days', 'All']);
    const counts = radios.map((r) => Number(r.querySelector('.chip__count')!.textContent));
    const byTier = [1, 2, 3, 4, 5, 6].map((t) => full.queue.filter((i) => i.tier === t).length);
    expect(counts).toEqual([10, ...byTier, full.queue.length]);
    expect(counts[1]).toBeGreaterThan(10 - 1); // tier 1 alone exceeds the cap, so the cap never hides a count
    expect(screen.getByText(`Showing 10 of ${full.queue.length}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: new RegExp(`View all \\(${full.queue.length}\\)`) })).toBeInTheDocument();
    // detail pane for the first item
    const detail = screen.getByRole('region', { name: 'Selected item' });
    expect(within(detail).getByRole('heading', { level: 2 })).toHaveTextContent(full.queue[0].title);
    expect(within(detail).getByText('Why it is here')).toBeInTheDocument();
    expect(within(detail).getByText('Key facts')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /^Open (task|account|alert|infrastructure)/ })).toBeInTheDocument();
    // Later: tab bar visible, collapsed (D-30)
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([`Upcoming (${full.upcoming.length})`, 'Recently changed (20)', 'Account load']);
    expect(tabs.every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('the detail pane never offers steps, a next action or a completion control (D-28, AC5)', async () => {
    await boot('/today');
    const detail = await screen.findByRole('region', { name: 'Selected item' });
    expect(detail.textContent).not.toMatch(/What to do|Mark complete|next action/i);
    expect(within(detail).queryByRole('button')).toBeNull();
  });

  it('tier chips list every item of the tier with no cap; All lists the whole queue with tier headings; ?show= survives a reload', async () => {
    const ds = newMock();
    const full = await ds.getToday();
    const tier1 = full.queue.filter((i) => i.tier === 1).length;
    const { user } = await boot('/today', ds);
    await user.click(await screen.findByRole('radio', { name: /Overdue \/ critical/ }));
    expect(loc()).toBe('/today?show=t1');
    expect(options(screen.getByRole('listbox'))).toHaveLength(tier1);
    expect(screen.getByText(`Showing ${tier1} of ${tier1}`)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View all/ })).toBeNull();
    await user.click(chip(/^Top 10/));
    expect(loc()).toBe('/today'); // default is not written to the URL
    await user.click(screen.getByRole('link', { name: /View all/ }));
    expect(loc()).toBe('/today?show=all');
    expect(chip(/^All/)).toHaveAttribute('aria-checked', 'true');
    expect(options(screen.getByRole('listbox'))).toHaveLength(full.queue.length);
    const groups = screen.getAllByRole('group').filter((g) => /items$/.test(g.getAttribute('aria-label') ?? ''));
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(
      [1, 2, 3, 4, 5, 6].map((t) => `${full.queue.find((i) => i.tier === t)!.tier_label}, ${full.queue.filter((i) => i.tier === t).length} items`),
    );
    cleanup();
    await boot('/today?show=t3', ds); // reload restores the state
    expect(await screen.findByRole('radio', { name: /^Alerts/ })).toHaveAttribute('aria-checked', 'true');
    cleanup();
    await boot('/today?show=bogus', ds); // unknown values fall back to top
    expect(await screen.findByRole('radio', { name: /^Top 10/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('upcoming-only objects never appear in the list, and there is no Plan chip (AC7, D-27)', async () => {
    const ds = newMock();
    const full = await ds.getToday();
    const { user } = await boot('/today?show=all', ds);
    await screen.findByRole('listbox');
    const shown = options(screen.getByRole('listbox')).map((o) => o.querySelector('b')!.textContent);
    expect(shown).toEqual(full.queue.map((i) => i.title));
    expect(screen.queryByRole('radio', { name: /^Plan/ })).toBeNull();
    void user;
  });

  it('Up/Down/Home/End move the selection and the detail; Enter opens; click selects only; double-click opens (AC4)', async () => {
    const ds = newMock();
    const full = await ds.getToday();
    const { user } = await boot('/today', ds);
    const list = await screen.findByRole('listbox');
    const detailTitle = () => within(screen.getByRole('region', { name: 'Selected item' })).getByRole('heading', { level: 2 }).textContent;
    const selected = () => options(list).findIndex((o) => o.getAttribute('aria-selected') === 'true');
    list.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(selected()).toBe(2);
    expect(detailTitle()).toBe(full.queue[2].title);
    expect(list.getAttribute('aria-activedescendant')).toBe(options(list)[2].id);
    await user.keyboard('{ArrowUp}');
    expect(selected()).toBe(1);
    await user.keyboard('{End}');
    expect(selected()).toBe(9);
    await user.keyboard('{ArrowDown}'); // no wrap
    expect(selected()).toBe(9);
    await user.keyboard('{Home}{ArrowUp}');
    expect(selected()).toBe(0);
    await user.click(options(list)[4]);
    expect(selected()).toBe(4);
    expect(loc()).toBe('/today'); // a click does not navigate
    await user.keyboard('{Enter}');
    await waitFor(() => expect(loc()).not.toBe('/today'));
    cleanup();
    go('/today');
    const again = await boot('/today', ds);
    const list2 = await screen.findByRole('listbox');
    await again.user.dblClick(options(list2)[1]);
    await waitFor(() => expect(loc()).not.toBe('/today'));
  });

  it('arrow keys work with no focus in the list, and Left/Right belong to a focused chip', async () => {
    const { user } = await boot('/today');
    const list = await screen.findByRole('listbox');
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{ArrowDown}');
    expect(options(list)[1]).toHaveAttribute('aria-selected', 'true');
    chip(/^Top 10/).focus();
    await user.keyboard('{ArrowDown}'); // Up/Down still move the list while a chip has focus
    expect(options(list)[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}'); // Left/Right move between chips
    expect(chip(/^Overdue \/ critical/)).toHaveAttribute('aria-checked', 'true');
  });

  it('changing the chip selects the first row; items route to their objects (task, alert, no account) per §4.2', async () => {
    const { user } = await boot('/today');
    await screen.findByRole('listbox');
    await user.click(chip(/^Alerts/));
    expect(options(screen.getByRole('listbox'))[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}'); // focus is on the chip; Enter on a chip must not open anything
    expect(loc()).toBe('/today?show=t3');
    await user.click(within(screen.getByRole('region', { name: 'Selected item' })).getByRole('link', { name: 'Open alert' }));
    await waitFor(() => expect(loc()).toMatch(/^\/bams\/alerts\?event=/));
    cleanup();
    const t = await boot('/today?show=t1');
    await screen.findByRole('listbox');
    const taskOpt = options(screen.getByRole('listbox')).find((o) => o.querySelector('small')?.textContent === 'No account') ?? options(screen.getByRole('listbox')).find((o) => !/(CPU|Disk|Memory|Network)/.test(o.textContent ?? ''))!;
    await t.user.click(taskOpt);
    await t.user.click(within(screen.getByRole('region', { name: 'Selected item' })).getByRole('link', { name: /^Open/ }));
    await waitFor(() => expect(loc()).toMatch(/^\/(tasks\?task=|accounts\/[^/]+\/(tasks\?task=|infrastructure))/));
  });

  it('the ring shows "N of M tasks done" from progress and updates after a task is completed (US-3.7)', async () => {
    const ds = newMock({ now: () => new Date('2026-10-12T15:00:00.000Z'), localMidnight: utcMidnight });
    const before = (await ds.getToday()).progress!;
    expect(before.done).toBe(8);
    const { user } = await boot('/today', ds);
    const ring = await screen.findByTestId('progress');
    expect(ring).toHaveTextContent(`${before.done} of ${before.total} tasks done`);
    expect(ring.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(ring).toHaveAttribute('title', '+2 other tasks completed');
    const st = await ds.getState();
    const plan = st.tasks.find((t) => t.status !== 'Complete' && t.due != null && t.due <= '2026-10-12' && t.client_id && st.accounts.find((a) => a.id === t.client_id)?.status === 'Active')!;
    await ds.saveTask({ ...taskToInput(plan), status: 'Complete' });
    await user.click(screen.getByRole('button', { name: 'Refresh Today' }));
    await waitFor(() => expect(screen.getByTestId('progress')).toHaveTextContent(`${before.done + 1} of ${before.total} tasks done`));
    const after = (await ds.getToday()).progress!;
    expect(after.done).toBeLessThanOrEqual(after.total);
    expect(after.total).toBe(before.total); // M is unchanged when an open plan task completes
  });

  it('M = 0 shows "No tasks due today" and no ring; N = M shows "All done"', async () => {
    const ds = newMock();
    const base = await ds.getToday();
    ds.getToday = async () => ({ ...base, progress: { day: base.today, total: 0, done: 0, open: 0, done_other: 0 } });
    await boot('/today', ds);
    expect(await screen.findByTestId('progress')).toHaveTextContent('No tasks due today');
    expect(screen.getByTestId('progress').querySelector('svg')).toBeNull();
    cleanup();
    const ds2 = newMock();
    ds2.getToday = async () => ({ ...base, progress: { day: base.today, total: 5, done: 5, open: 0, done_other: 0 } });
    await boot('/today', ds2);
    const r = await screen.findByTestId('progress');
    expect(r).toHaveTextContent('5 of 5 tasks done');
    expect(r).toHaveTextContent('All done');
    expect(r.querySelector('.ring__check')).not.toBeNull();
  });

  it('Later tabs: click opens a panel, click again collapses; Account load shows at most 8 rows and an All accounts link (US-3.8)', async () => {
    const { user } = await boot('/today');
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('tab', { name: /^Upcoming/ }));
    expect(screen.getByRole('tab', { name: /^Upcoming/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getAllByRole('link').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: /^Upcoming/ }));
    expect(screen.queryByRole('tabpanel')).toBeNull();
    await user.click(screen.getByRole('tab', { name: /^Recently changed/ }));
    expect(within(screen.getByRole('tabpanel')).getAllByRole('listitem').length).toBe(20);
    await user.click(screen.getByRole('tab', { name: 'Account load' }));
    const table = within(screen.getByRole('tabpanel')).getByRole('table', { name: 'Account load' });
    expect(within(table).getAllByRole('row').length - 1).toBeLessThanOrEqual(8);
    expect(within(table).getAllByRole('row').length - 1).toBe(8);
    expect(screen.getByRole('link', { name: /All accounts \(10\)/ })).toHaveAttribute('href', '/accounts');
    expect(document.querySelector('[role="dialog"]')).toBeNull(); // no drawer
  });

  it('nav rail: Today/Accounts/Tasks/Settings/BAMS work; Operations is built (no Later tag); Bridge shows "Later"; no Journal', async () => {
    const { user } = await boot('/today');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByText(/journal/i)).toBeNull();
    expect(within(nav).getAllByText('Later')).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: /Operations/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Operations' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'BAMS' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'BAMS' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument();
  });
});

describe('Accounts and Workspace', () => {
  it('Accounts: dense sortable table; default Active filter and overdue-desc sort; search by BPID; row opens the workspace', async () => {
    const { user } = await boot('/accounts');
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(10); // 10 Active
    expect(within(table).getByRole('columnheader', { name: /Overdue/ })).toHaveAttribute('aria-sort', 'descending');
    const overdue = rows.map((r) => Number(within(r).getAllByRole('cell')[2].textContent));
    expect(overdue).toEqual([...overdue].sort((a, b) => b - a));
    await user.type(screen.getByLabelText(/Search accounts/), '3122857');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
    await user.click(within(table).getByRole('link', { name: /Halvorsen/ }));
    await waitFor(() => expect(loc()).toMatch(/^\/accounts\/[^/]+\/overview$/));
    expect(await screen.findByRole('heading', { level: 1, name: /Halvorsen/ })).toBeInTheDocument();
  });

  it('Accounts refresh: tile strip, needs-attention list (max 4, no score), instruments in the table (US-4.2)', async () => {
    await boot('/accounts');
    const table = await screen.findByRole('table', { name: 'Accounts' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter((h) => h && h !== 'Open')).toEqual(['Account', 'Load', 'Overdue', 'Waiting', 'Alerts', 'Servers', 'Next upgrade', 'Next contact', 'Activity']);
    const portfolio = screen.getByRole('region', { name: 'Portfolio' });
    expect(portfolio).toHaveTextContent(/10\s*active accounts/);
    expect(screen.getByRole('region', { name: 'Open load by account' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Next 15 days: \d+ upgrades, \d+ client touches$/ })).toBeInTheDocument();
    const attn = await screen.findByRole('region', { name: 'Needs attention' });
    await waitFor(() => expect(within(attn).getAllByRole('link').length).toBeGreaterThan(0));
    expect(within(attn).getAllByRole('link').length).toBeLessThanOrEqual(4);
    expect(attn.textContent).not.toMatch(/\b(score|health|grade)\b/i);
    // every row has a load bar with a text equivalent and a servers dot row; activity sparkline once the trend loads
    const row = within(table).getAllByRole('row')[1];
    expect(within(row).getByRole('img', { name: /open: \d+ overdue, \d+ waiting, \d+ other/ })).toBeInTheDocument();
    expect(within(row).getByRole('img', { name: /\d+ servers?, \d+ with an alert/ })).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByRole('img', { name: /^Activity, last 14 days: \d+ entr/ })).toBeInTheDocument());
  });

  it('Accounts: Inactive filter lists the 2 inactive accounts; columns have no health score', async () => {
    const { user } = await boot('/accounts');
    await user.click(await screen.findByRole('radio', { name: 'Inactive' }));
    expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(screen.queryByText(/health/i)).toBeNull();
  });

  async function openHalvorsen(tab = 'overview') {
    const ds = newMock();
    const id = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!.id;
    const ctx = await boot(`/accounts/${id}/${tab}`, ds);
    await screen.findByRole('heading', { level: 1, name: /Halvorsen/ });
    return { ...ctx, id };
  }

  it('Workspace header counts, tabs synced to the URL, arrow-key tab navigation', async () => {
    const { user, id } = await openHalvorsen();
    const counts = screen.getByRole('group', { name: 'Account counts' });
    expect(counts).toHaveTextContent(/Open tasks\s*12/);
    expect(counts).toHaveTextContent(/3 overdue/);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.map((t) => t?.replace(/\d+$/, '').trim())).toEqual(['Overview', 'Tasks', 'Activity', 'Infrastructure', 'Contacts']);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    overview.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(loc()).toBe(`/accounts/${id}/tasks`));
    expect(screen.getByRole('tab', { name: /Tasks/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    await waitFor(() => expect(loc()).toBe(`/accounts/${id}/contacts`));
  });

  it('Workspace refresh: header band cells, Top item, due histogram, server tiles and the upgrade timeline (US-5.6)', async () => {
    await openHalvorsen();
    const band = screen.getByRole('group', { name: 'Account counts' });
    for (const cap of ['Open tasks', 'Servers', 'Alerts', 'Next upgrade', 'Next client touch']) expect(within(band).getByText(cap)).toBeInTheDocument();
    // exclusive meter: 12 open = 3 overdue + 2 waiting + 7 other (an overdue Waiting task counts once)
    const meter = within(band).getByRole('img', { name: /^12 open: \d+ overdue, \d+ waiting, \d+ other$/ });
    const n = /(\d+) open: (\d+) overdue, (\d+) waiting, (\d+) other/.exec(meter.getAttribute('aria-label')!)!.slice(1).map(Number);
    expect(n[1] + n[2] + n[3]).toBe(n[0]);
    expect(await screen.findByRole('article', { name: 'Top item for this account' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Top item for this account' }).textContent).not.toMatch(/Mark complete|What to do/);
    expect(screen.getByRole('img', { name: /open tasks over 20 days/ })).toBeInTheDocument();
    const tiles = await screen.findByRole('list', { name: 'Servers' });
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(3);
    expect(within(tiles).getAllByText('No trend data').length).toBeGreaterThan(0); // a server with no samples: no sparkline
    expect(within(tiles).getAllByRole('img').length).toBeGreaterThan(0); // and at least one with a series
    expect(screen.getByRole('table', { name: 'Upgrades in the next 30 days' })).toBeInTheDocument();
  });

  it('Overview shows up to 8 open tasks sorted overdue first, then priority, then due (US-5.3)', async () => {
    await openHalvorsen();
    const table = await screen.findByRole('table', { name: /Top open tasks/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.length).toBe(8);
    // the first rows are the overdue ones
    expect(rows[0]).toHaveTextContent(/overdue/);
    expect(rows[1]).toHaveTextContent(/overdue/);
    const texts = rows.map((r) => /overdue/.test(r.textContent ?? ''));
    expect(texts.indexOf(false)).toBeGreaterThanOrEqual(0);
    expect(texts.slice(texts.indexOf(false)).every((x) => !x)).toBe(true);
    expect(screen.getByRole('link', { name: /View all \(12\)/ })).toBeInTheDocument();
  });

  it('Tasks tab lists only this account\'s tasks with the Open filter by default and offers every column', async () => {
    const { user } = await openHalvorsen('tasks');
    const table = await screen.findByRole('table', { name: /tasks/ });
    for (const h of ['Task', 'Category', 'Priority', 'Due', 'Next update', 'Status', 'Waiting on', 'Updated']) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(h) })).toBeInTheDocument();
    }
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(12);
    await user.click(screen.getByRole('combobox', { name: 'Priority filter' }));
    await user.click(screen.getByRole('option', { name: 'High' }));
    expect(within(table).getAllByRole('row').slice(1).every((r) => /High/.test(r.textContent ?? ''))).toBe(true);
  });

  it('Mark complete is available per row and updates the counts', async () => {
    const { user } = await openHalvorsen('tasks');
    const table = await screen.findByRole('table', { name: /tasks/ });
    const before = within(table).getAllByRole('row').length;
    await user.click(within(table).getAllByRole('button', { name: /Mark complete/ })[0]);
    await waitFor(() => expect(within(screen.getByRole('table', { name: /tasks/ })).getAllByRole('row').length).toBe(before - 1));
    expect(await screen.findByText('Task completed')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Account counts' })).toHaveTextContent(/Open tasks\s*11/);
  });

  it('Activity tab: filters, system events have no edit/delete controls, notes do (US-7.4)', async () => {
    const { user } = await openHalvorsen('activity');
    await screen.findByText('SYSTEM', { selector: '.sysevent__label' }).catch(() => null);
    await waitFor(() => expect(document.querySelector('.sysevent')).not.toBeNull());
    const sys = document.querySelector('.sysevent')!;
    expect(within(sys as HTMLElement).queryByRole('button')).toBeNull();
    expect(sys.closest('article')).toBeNull();
    const note = document.querySelector('article.note')!;
    expect(within(note as HTMLElement).getByRole('button', { name: /Delete note/ })).toBeInTheDocument();
    expect(within(note as HTMLElement).getByRole('link', { name: /Edit note/ })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'System events' }));
    await waitFor(() => expect(document.querySelector('article.note')).toBeNull());
    await user.click(screen.getByRole('radio', { name: 'Call notes' }));
    await waitFor(() => expect(document.querySelector('.sysevent')).toBeNull());
    expect(document.querySelectorAll('article.note').length).toBeGreaterThan(0);
  });

  it('Activity: "+ Note" menu opens a new note drawer; saving it adds the note; delete uses a confirm dialog', async () => {
    const { user } = await openHalvorsen('activity');
    await user.click(await screen.findByRole('button', { name: 'Choose note type' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call note' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('radio', { name: 'Call' })).toHaveAttribute('aria-checked', 'true');
    await user.type(within(dlg).getByLabelText('Subject'), 'Call with desk head');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const created = await screen.findByRole('article', { name: /Call Note: Call with desk head/ });
    await user.click(within(created).getByRole('button', { name: /Delete note/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/safety backup is created first/i)).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Call with desk head/ })).not.toBeInTheDocument());
  });

  it('Infrastructure tab: BAMS appliance panels with Open in BAMS, upgrade table, ?server= highlights matching rows (US-9.1)', async () => {
    const ds = newMock();
    const id = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!.id;
    await boot(`/accounts/${id}/infrastructure?server=hfa-bpipe-dev-01`, ds);
    const upgrades = await screen.findByRole('table', { name: 'Server upgrades' });
    expect((await screen.findAllByRole('link', { name: /Open in BAMS/ })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('table', { name: / metrics$/ }).length).toBeGreaterThan(0);
    const hi = upgrades.querySelectorAll('tr.is-highlight');
    expect(hi.length).toBeGreaterThan(0);
    expect([...hi].every((r) => /hfa-bpipe-dev-01/.test(r.textContent ?? ''))).toBe(true);
    expect(screen.queryByRole('button', { name: /^(add|edit|new)/i })).toBeNull();
  });

  it('Contacts: making another contact primary clears the old one and confirms with a toast (US-8.2)', async () => {
    const { user } = await openHalvorsen('contacts');
    const table = await screen.findByRole('table', { name: /contacts/ });
    const primaries = () => within(table).getAllByRole('button', { name: /primary/i }).filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(primaries()).toHaveLength(1);
    const oldName = /^(.+) is primary/.exec(primaries()[0].getAttribute('aria-label')!)![1];
    const other = within(table).getAllByRole('button', { name: /^Make .* primary$/ })[0];
    const newName = /^Make (.+) primary$/.exec(other.getAttribute('aria-label')!)![1];
    await user.click(other);
    expect(await screen.findByText(`${newName} is now primary (was ${oldName})`)).toBeInTheDocument();
    await waitFor(() => expect(primaries()).toHaveLength(1));
    expect(primaries()[0].getAttribute('aria-label')).toContain(newName);
  });

  it('Edit account drawer saves; the danger zone requires typing the exact name (D-12)', async () => {
    const { user, id } = await openHalvorsen();
    await user.click(screen.getByRole('link', { name: /Edit account/ }));
    const dlg = await screen.findByRole('dialog');
    expect(loc()).toContain('account=edit');
    await user.click(within(dlg).getByRole('button', { name: /Delete account/ }));
    const confirm = await screen.findByRole('alertdialog');
    const del = within(confirm).getByRole('button', { name: 'Delete account' });
    expect(del).toBeDisabled();
    await user.type(within(confirm).getByRole('textbox'), 'halvorsen');
    expect(del).toBeDisabled();
    await user.clear(within(confirm).getByRole('textbox'));
    await user.type(within(confirm).getByRole('textbox'), 'Halvorsen Fjord Asset Management');
    expect(del).toBeEnabled();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(id).toBeTruthy();
  });
});

describe('overlays, Quick Capture and account jump', () => {
  it('N opens Quick Capture on any page (not inside inputs), Escape closes a pristine dialog and focus returns', async () => {
    const { user } = await boot('/accounts');
    await screen.findByRole('heading', { level: 1, name: 'Accounts' });
    const search = screen.getByLabelText(/Search accounts/);
    await user.click(search);
    await user.keyboard('n');
    expect(screen.queryByRole('dialog')).toBeNull(); // typed into the field instead
    expect(search).toHaveValue('n');
    await user.clear(search);
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('n');
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(within(dlg).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Task', 'Client follow-up', 'Meeting note', 'Call note', 'General note']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('QA-E2-3: the top-bar + Capture button prefills the current account inside a workspace, and N agrees', async () => {
    const ds = newMock();
    const acct = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!;
    const { user } = await boot(`/accounts/${acct.id}/infrastructure`, ds);
    await screen.findByRole('heading', { level: 1, name: /Halvorsen/ });
    await user.click(screen.getByRole('button', { name: /Capture/ }));
    let dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    const field = () => within(dlg).getByRole('combobox', { name: /Account/ });
    expect((field() as HTMLInputElement).value).toMatch(/Halvorsen/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('n');
    dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    expect((field() as HTMLInputElement).value).toMatch(/Halvorsen/);
  });

  it('QA-E2-3: outside a workspace the + Capture button leaves the account empty', async () => {
    const { user } = await boot('/today');
    await user.click(await screen.findByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    expect((within(dlg).getByRole('combobox', { name: /Account/ }) as HTMLInputElement).value).toBe('');
  });

  it('+ Capture button saves a task with Ctrl+Enter, toasts with a View link, and refreshes Today', async () => {
    const { user } = await boot('/today');
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    await user.type(within(dlg).getByLabelText(/^Task/), 'Capture test task');
    await user.click(within(dlg).getByRole('button', { name: 'Today' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const toast = await screen.findByText('Task created');
    expect(within(toast.closest('.toast') as HTMLElement).getByRole('link', { name: 'View' })).toBeInTheDocument();
    await user.click(await screen.findByRole('radio', { name: /^Due today/ }));
    expect(await screen.findByText('Capture test task')).toBeInTheDocument();
  });

  it('Client follow-up requires an account and a due date, prefills the title, and offers the next-touch checkbox', async () => {
    const { user } = await boot('/today');
    await user.click(await screen.findByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    await user.click(within(dlg).getByRole('radio', { name: 'Client follow-up' }));
    expect(within(dlg).getByRole('checkbox', { name: /Update Next Client Touch/ })).toBeChecked();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await within(dlg).findByText('Choose an account.')).toBeInTheDocument();
    expect(within(dlg).getByText('A due date is required for a follow-up.')).toBeInTheDocument();
    const acct = within(dlg).getByRole('combobox', { name: /Account/ });
    await user.click(acct);
    await user.click((await screen.findAllByRole('option'))[0]);
    expect((within(dlg).getByLabelText(/Follow-up task/) as HTMLInputElement).value).toMatch(/^Follow up with /);
  });

  it('a dirty dialog asks "Discard changes?" with Keep editing focused first', async () => {
    const { user } = await boot('/today');
    await user.click(await screen.findByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    await user.type(within(dlg).getByLabelText(/^Task/), 'unsaved');
    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Discard changes?')).toBeInTheDocument();
    expect(within(confirm).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Quick capture' })).toBeInTheDocument(); // still open
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('dialogs trap focus: Tab cycles inside and never reaches the page behind', async () => {
    const { user } = await boot('/today');
    await user.click(await screen.findByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    for (let i = 0; i < 25; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it('Ctrl+K focuses the account jump; typing + Enter opens that account Overview (US-10.2)', async () => {
    const { user } = await boot('/today');
    await user.keyboard('{Control>}k{/Control}');
    const jump = screen.getByRole('combobox', { name: 'Jump to account' });
    expect(jump).toHaveFocus();
    await user.type(jump, 'ostrava');
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(loc()).toMatch(/^\/accounts\/[^/]+\/overview$/));
    expect(await screen.findByRole('heading', { level: 1, name: /Ostrava/ })).toBeInTheDocument();
  });

  it('Settings: changing a setting saves it and the runtime panel is read-only', async () => {
    sessionStorage.clear();
    const { user } = await boot('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await user.click(screen.getByRole('radio', { name: 'GMT' }));
    expect(await screen.findByText('Time display saved')).toBeInTheDocument();
    expect(screen.getByText('DEV', { selector: 'dd' })).toBeInTheDocument();
    // Data and Logging are collapsed by default; nothing inside is rendered or reachable
    const data = screen.getByRole('button', { name: /^Data/ });
    const logging = screen.getByRole('button', { name: /^Logging/ });
    expect(data).toHaveAttribute('aria-expanded', 'false');
    expect(logging).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Create backup now/ })).toBeNull();
    expect(screen.queryByText('Recent log')).toBeNull();
    data.focus();
    await user.keyboard('{Enter}');
    expect(data).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: /Create backup now/ }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect((await screen.findAllByText(/^tam_manual_/)).length).toBeGreaterThan(0);
    await user.click(logging);
    expect(await screen.findByText('Recent log')).toBeInTheDocument();
    await user.click(logging);
    expect(logging).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Recent log')).toBeNull();
    sessionStorage.clear();
  });

  it('Settings: open state is remembered for the session only (sessionStorage)', async () => {
    sessionStorage.clear();
    sessionStorage.setItem('tam.panel.settings-logging', '1');
    await boot('/settings');
    expect(await screen.findByRole('button', { name: /^Logging/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Data/ })).toHaveAttribute('aria-expanded', 'false');
    sessionStorage.clear();
  });

  it('shows an error banner with Retry when the first load fails, and recovers', async () => {
    const ds = newMock();
    ds.failNext = 1;
    const { user } = await bootRaw('/today', ds);
    expect(await screen.findByText('Could not start the app')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('keeps showing data and a stale banner when a refresh fails (guidelines §12)', async () => {
    const ds = newMock();
    const { user } = await boot('/today', ds);
    await screen.findByRole('listbox');
    ds.failNext = 1;
    await user.click(screen.getByRole('button', { name: 'Refresh Today' }));
    expect(await screen.findByText(/Showing data from/)).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

async function bootRaw(path: string, ds: ReturnType<typeof newMock>) {
  go(path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  return { user };
}

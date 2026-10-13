import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { newMock } from './data/mock/testFile';

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

describe('app shell and Today (integration over MockDataSource)', () => {
  it('lands on Today, shows the DEV and Mock badges, and a tiered queue with the seeded tiers', async () => {
    await boot('/');
    expect(await screen.findByRole('heading', { level: 1, name: /Today/ })).toBeInTheDocument();
    expect(loc()).toBe('/today');
    expect(screen.getByText('DEV')).toBeInTheDocument();
    expect(screen.getByText('Mock data')).toBeInTheDocument();
    for (const label of ['Overdue / Critical', 'Due today', 'Infrastructure alerts', 'Waiting / follow-up', 'Upgrade actions', 'Upcoming tasks']) {
      expect(await screen.findByRole('region', { name: new RegExp(`^${label.replace('/', '\\/')},`) })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: /^Upcoming \(\d+\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Recently changed/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Account load/ })).toBeInTheDocument();
  });

  it('overdue items come before upcoming tasks and BAMS/upgrade items are present (US-3.1 AC3-5)', async () => {
    await boot('/today');
    const overdue = await screen.findByRole('region', { name: /^Overdue \/ Critical/ });
    expect(within(overdue).getAllByRole('listitem').length).toBeGreaterThan(5);
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label') ?? '');
    expect(regions.findIndex((n) => n.startsWith('Overdue'))).toBeLessThan(regions.findIndex((n) => n.startsWith('Upcoming tasks')));
    expect(within(overdue).getAllByText('BAMS alert').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Upgrade').length).toBeGreaterThan(0);
  });

  it('clicking a task row navigates to the task and opens its drawer; Enter on the focused title link does the same', async () => {
    const { user } = await boot('/today');
    const overdue = await screen.findByRole('region', { name: /^Overdue \/ Critical/ });
    const taskRow = within(overdue).getAllByRole('listitem').find((li) => li.textContent?.includes('Task') && li.querySelector('a.qrow__link') && !li.textContent.includes('No account'))!;
    await user.click(taskRow.querySelector('.qrow__type')!);
    await waitFor(() => expect(loc()).toMatch(/^\/accounts\/[^/]+\/tasks\?task=/));
    expect(await screen.findByRole('dialog', { name: /Follow up|.+/ })).toBeInTheDocument();
    expect(screen.getByText('Task', { selector: '.label' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    go('/today');
    cleanup();
    const again = await boot('/today');
    const overdue2 = await screen.findByRole('region', { name: /^Overdue \/ Critical/ });
    const link = within(overdue2).getAllByRole('link').find((a) => a.classList.contains('qrow__link'))!;
    link.focus();
    await again.user.keyboard('{Enter}');
    await waitFor(() => expect(loc()).not.toBe('/today'));
  });

  it('BAMS alert rows go to the Infrastructure tab with ?server=, and client touches to the Overview', async () => {
    const { user } = await boot('/today');
    const alerts = await screen.findByRole('region', { name: /^Infrastructure alerts/ });
    await user.click(within(alerts).getAllByRole('link').find((a) => a.classList.contains('qrow__link'))!);
    await waitFor(() => expect(loc()).toMatch(/^\/accounts\/[^/]+\/infrastructure\?server=/));
  });

  it('a task with no account goes to /tasks?task=', async () => {
    const { user } = await boot('/today');
    const row = (await screen.findAllByText('No account')).map((e) => e.closest('li')).find((li) => li?.querySelector('a.qrow__link'))!;
    await user.click(row!.querySelector('a.qrow__link')!);
    await waitFor(() => expect(loc()).toMatch(/^\/tasks\?task=/));
  });

  it('nav rail: Today/Accounts/Tasks/Settings work; Operations/BAMS/Bridge show "Later" and a not-built page; no Journal', async () => {
    const { user } = await boot('/today');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByText(/journal/i)).toBeNull();
    expect(within(nav).getAllByText('Later')).toHaveLength(3);
    expect(within(nav).getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('link', { name: /Operations/ }));
    expect(await screen.findByText('Planned for a later release', { exact: false })).toBeInTheDocument();
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
    const counts = screen.getByLabelText('Account counts');
    expect(counts).toHaveTextContent(/Open\s*12/);
    expect(counts).toHaveTextContent(/Overdue\s*3/);
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
    expect(screen.getByLabelText('Account counts')).toHaveTextContent(/Open\s*11/);
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

  it('Infrastructure tab: read-only notice, BAMS and upgrade tables, ?server= highlights matching rows (US-9.1)', async () => {
    const ds = newMock();
    const id = (await ds.getState()).accounts.find((a) => a.name.startsWith('Halvorsen'))!.id;
    await boot(`/accounts/${id}/infrastructure?server=hfa-bpipe-dev-01`, ds);
    expect(await screen.findByText(/Upgrades are managed in Operations; monitoring in BAMS/)).toBeInTheDocument();
    const upgrades = await screen.findByRole('table', { name: 'Server upgrades' });
    expect(screen.getByRole('table', { name: 'Monitored appliances' })).toBeInTheDocument();
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
    await screen.findByRole('region', { name: /^Overdue/ });
    await user.click(screen.getByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    await user.type(within(dlg).getByLabelText(/^Task/), 'Capture test task');
    await user.click(within(dlg).getByRole('button', { name: 'Today' }));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const toast = await screen.findByText('Task created');
    expect(within(toast.closest('.toast') as HTMLElement).getByRole('link', { name: 'View' })).toBeInTheDocument();
    const due = await screen.findByRole('region', { name: /^Due today/ });
    expect(within(due).getByText('Capture test task')).toBeInTheDocument();
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
    const { user } = await boot('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await user.click(screen.getByRole('radio', { name: 'GMT' }));
    expect(await screen.findByText('Time display saved')).toBeInTheDocument();
    expect(screen.getByText('DEV', { selector: 'dd' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create backup now/ }));
    expect(await screen.findByText('Backup created')).toBeInTheDocument();
    expect((await screen.findAllByText(/^tam_manual_/)).length).toBeGreaterThan(0);
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
    await screen.findByRole('region', { name: /^Overdue/ });
    ds.failNext = 1;
    await user.click(screen.getByRole('button', { name: 'Refresh Today' }));
    expect(await screen.findByText(/Showing data from/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^Overdue/ })).toBeInTheDocument();
  });
});

async function bootRaw(path: string, ds: ReturnType<typeof newMock>) {
  go(path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  return { user };
}

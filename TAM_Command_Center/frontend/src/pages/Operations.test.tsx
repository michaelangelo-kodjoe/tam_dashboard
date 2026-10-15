// Operations page against the mock adapter (T-171): grouping, selection, Set version, quarter dialog, deep links.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { newMock } from '../data/mock/testFile';

async function boot(path = '/operations', ds = newMock()) {
  window.history.pushState({}, '', path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('table', { name: /Appliance upgrades grouped by account/i }, { timeout: 4000 });
  return { user, ds };
}
beforeEach(() => { document.body.style.overflow = ''; });
afterEach(() => cleanup());

describe('Operations page', () => {
  it('is a real page: no Later tag, no header Target version display, accounts collapsed by default', async () => {
    const { ds } = await boot();
    const d = await ds.getOperations({});
    expect(screen.getByRole('link', { name: /Operations/ })).not.toHaveTextContent('Later');
    expect(screen.getAllByRole('columnheader', { name: 'Target version' })).toHaveLength(1);
    expect(screen.queryAllByRole('row').filter((r) => r.classList.contains('ops-row'))).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: /^Expand (?!all)/ }).length).toBe(d.groups.length);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Select all \(/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
    expect(screen.getByText(new RegExp(`^${d.summary.total} appliances?`))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: d.groups[0].client_name })).toHaveAttribute('href', expect.stringContaining(`/accounts/${d.groups[0].client_id}`));
  });

  it('Expand all shows every appliance; group checkbox selects children, bar counts, Set version applies and clears', async () => {
    const { user, ds } = await boot();
    const d = await ds.getOperations({});
    const toggle = screen.getByRole('button', { name: 'Expand all accounts' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse all accounts' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    const g = d.groups[0];
    expect(document.querySelectorAll('.ops-row')).toHaveLength(d.summary.total);
    await user.click(screen.getByRole('checkbox', { name: `Select all ${g.client_name}` }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(bar).toHaveTextContent(`${g.rows.length} selected`);
    await user.click(screen.getByRole('checkbox', { name: `Select ${g.rows[0].appliance}` }));
    expect(screen.getByRole('checkbox', { name: `Select all ${g.client_name}` })).toHaveProperty('indeterminate', g.rows.length > 1);
    await user.click(screen.getByRole('checkbox', { name: `Select ${g.rows[0].appliance}` }));
    await user.click(within(bar).getByRole('button', { name: 'Set version' }));
    const dlg = await screen.findByRole('dialog', { name: 'Set version' });
    expect(dlg).toHaveTextContent(`Apply to ${g.rows.length}`);
    await user.type(within(dlg).getByLabelText(/Target version/), '7.7.7');
    await user.click(within(dlg).getByRole('button', { name: 'Set version' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set version' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    const after = (await ds.getOperations({})).groups.find((x) => x.client_id === g.client_id)!;
    const set = after.rows.filter((r) => r.version.source === 'appliance');
    expect(set.length).toBeGreaterThan(0);
    expect(set.every((r) => r.version.effective === '7.7.7')).toBe(true);
  });

  it('Select all (N) counts the filtered set; a search auto-expands matching accounts', async () => {
    const { user, ds } = await boot();
    const d = await ds.getOperations({});
    await user.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: `Select all (${d.summary.total})` })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Select all (${d.summary.total})` }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent(`${d.summary.total} selected`);
    await user.click(screen.getByRole('button', { name: 'Done selecting' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    const one = d.groups[0].rows[0];
    await user.type(screen.getByRole('searchbox', { name: /Search account or appliance/ }), one.appliance);
    await waitFor(() => expect(document.querySelectorAll('.ops-row').length).toBeGreaterThan(0));
    expect(screen.getByText(new RegExp(`of ${d.appliance_total} appliances match`))).toBeInTheDocument();
    expect(window.location.search).toContain('q=');
  });

  it('the Edit quarter dialog carries Target version and the quarter in the URL deep-links', async () => {
    const ds = newMock();
    const d = await ds.getOperations({});
    const sel = d.quarters[0];
    const { user } = await boot(`/operations?quarter=${sel.year}-${sel.quarter}`, ds);
    expect(screen.getByRole('combobox', { name: 'Quarter' })).toHaveTextContent(sel.label);
    await user.click(screen.getByRole('button', { name: 'Edit quarter' }));
    const dlg = await screen.findByRole('dialog', { name: `Edit ${sel.label}` });
    expect(within(dlg).getByLabelText('Target version')).toHaveValue(sel.target_version ?? '');
    expect(within(dlg).getByLabelText('DEV date')).toBeInTheDocument();
  });

  it('an appliance deep link opens its edit dialog', async () => {
    const ds = newMock();
    const d = await ds.getOperations({});
    const r = d.groups[0].rows[0];
    await boot(`/operations?appliance=${r.object_id}`, ds);
    expect(await screen.findByRole('dialog', { name: `Edit ${r.appliance}` })).toBeInTheDocument();
  });

  it('status is a colored badge that opens the menu; choosing persists (keyboard and ARIA kept)', async () => {
    const { user, ds } = await boot();
    const d = await ds.getOperations({});
    await user.click(screen.getByRole('button', { name: 'Expand all accounts' }));
    const r = d.groups[0].rows.find((x) => x.status === 'Planned') ?? d.groups[0].rows[0];
    const trig = screen.getByRole('combobox', { name: `Status for ${r.appliance}` });
    expect(trig.querySelector('.badge')).toHaveTextContent(r.status);
    trig.focus();
    await user.keyboard('{Enter}');
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(expect.arrayContaining(['Planned', 'Deferred']));
    expect(opts[0].querySelector('.badge')).not.toBeNull();
    await user.click(screen.getByRole('option', { name: 'Deferred' }));
    await waitFor(async () => {
      const row = (await ds.getOperations({})).groups.flatMap((g) => g.rows).find((x) => x.object_id === r.object_id)!;
      expect(row.status).toBe('Deferred');
    });
  });

  it('Enter in a text input submits the dialogs; Enter in the note textarea does not', async () => {
    const ds = newMock();
    const d = await ds.getOperations({});
    const r = d.groups[0].rows[0];
    const { user } = await boot(`/operations?appliance=${r.object_id}`, ds);
    const dlg = await screen.findByRole('dialog', { name: `Edit ${r.appliance}` });
    await user.type(within(dlg).getByLabelText('Note'), 'line one{Enter}line two');
    expect(screen.getByRole('dialog', { name: `Edit ${r.appliance}` })).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Note')).toHaveValue('line one\nline two');
    await user.type(within(dlg).getByLabelText('Target version'), '8.8.8{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const after = (await ds.getOperations({})).groups.flatMap((g) => g.rows).find((x) => x.object_id === r.object_id)!;
    expect(after).toMatchObject({ notes: 'line one\nline two', version: { own: '8.8.8' } });

    await user.click(screen.getByRole('button', { name: 'Edit quarter' }));
    const q = await screen.findByRole('dialog', { name: /^Edit / });
    await user.type(within(q).getByLabelText('Target version'), '1{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Enter in the Set version field applies it', async () => {
    const { user, ds } = await boot();
    const d = await ds.getOperations({});
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('button', { name: 'Expand all accounts' }));
    await user.click(screen.getByRole('checkbox', { name: `Select all ${d.groups[0].client_name}` }));
    await user.click(screen.getByRole('button', { name: 'Set version' }));
    const dlg = await screen.findByRole('dialog', { name: 'Set version' });
    await user.type(within(dlg).getByLabelText(/Target version/), '6.6.6{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const g = (await ds.getOperations({})).groups[0];
    expect(g.rows.some((x) => x.version.own === '6.6.6')).toBe(true);
  });

  it('the Workspace Infrastructure tab links to Operations filtered by the account name', async () => {
    const ds = newMock();
    const d = await ds.getOperations({});
    const g = d.groups[0];
    window.history.pushState({}, '', `/accounts/${g.client_id}/infrastructure`);
    render(<App ds={ds} />);
    const link = await screen.findByRole('link', { name: /Open in Operations/ });
    expect(link).toHaveAttribute('href', `/operations?q=${encodeURIComponent(g.client_name)}`);
  });
});

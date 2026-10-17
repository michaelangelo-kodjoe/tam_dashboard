// Settings > Audit log, Backups kinds, ?section=audit deep link.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';
import { DataSourceError } from '../../data/DataSource';

async function boot(path = '/settings', ds = newMock()) {
  sessionStorage.clear();
  window.history.pushState({}, '', path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('heading', { level: 1, name: 'Settings' });
  return { user, ds };
}
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe('Audit log', () => {
  it('is collapsed by default and loads nothing until opened; opens with ?section=audit', async () => {
    const ds = newMock();
    const spy = vi.spyOn(ds, 'getAudit');
    const { user } = await boot('/settings', ds);
    const head = screen.getByRole('button', { name: /^Audit log/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(spy).not.toHaveBeenCalled();
    await user.click(head);
    expect(await screen.findByRole('table', { name: /Audit log, newest first/ })).toBeInTheDocument();
    cleanup();
    await boot('/settings?section=audit', ds);
    expect(screen.getByRole('button', { name: /^Audit log/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('lists newest first with local-time stamps, total and paging; a row shows reason and old/new values', async () => {
    const ds = newMock();
    const all = await ds.getAudit({ limit: 200 });
    const { user } = await boot('/settings?section=audit', ds);
    const table = await screen.findByRole('table', { name: /Audit log, newest first/ });
    const rows = table.querySelectorAll('tbody tr.au-row');
    expect(rows.length).toBe(Math.min(50, all.total));
    expect(screen.getByText(new RegExp(`^1-${rows.length} of ${all.total}$`))).toBeInTheDocument();
    expect(table.textContent).toMatch(/\d{1,2}:\d\d (AM|PM)/);
    expect(table.textContent).not.toMatch(/GMT|UTC/);
    const ts = all.items.map((e) => e.timestamp);
    expect(ts).toEqual([...ts].sort().reverse());
    if (all.total > 50) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => expect(screen.getByText(new RegExp(`^51-`))).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Previous' }));
    }
    const live = await screen.findByRole('table', { name: /Audit log, newest first/ });
    await user.click(within(live).getAllByRole('button', { name: /Show details/ })[0]);
    expect(within(live).getByText('Reason')).toBeInTheDocument();
    expect(within(live).getByText('Before')).toBeInTheDocument();
    expect(within(live).getByText('After')).toBeInTheDocument();
  });

  it('filters by category and search narrow the list and the count', async () => {
    const ds = newMock();
    const facets = await ds.getAuditFacets();
    const cat = facets.categories[0];
    const expected = (await ds.getAudit({ category: cat })).total;
    const { user } = await boot('/settings?section=audit', ds);
    await screen.findByRole('table', { name: /Audit log/ });
    await user.click(screen.getByRole('combobox', { name: 'Category filter' }));
    await user.click(await screen.findByRole('option', { name: cat }));
    await waitFor(() => expect(screen.getByText(new RegExp(`of ${expected}$`))).toBeInTheDocument());
    await user.type(screen.getByRole('searchbox', { name: 'Search audit log' }), 'zzz-no-such-thing');
    expect(await screen.findByText('No audit events match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await screen.findByRole('table', { name: /Audit log/ });
  });

  it('Download CSV passes the current filters (no Excel button); a 413 shows the narrow-filters message', async () => {
    const ds = newMock();
    const exp = vi.spyOn(ds, 'exportAudit');
    const { user } = await boot('/settings?section=audit', ds);
    await screen.findByRole('table', { name: /Audit log/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search audit log' }), 'task');
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search audit log' })).toHaveValue('task'));
    await new Promise((r) => setTimeout(r, 400));
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith(expect.objectContaining({ q: 'task' })));
    exp.mockRejectedValueOnce(new DataSourceError('payload_too_large', 'More than 50,000 rows match. Narrow the filters.', undefined, 413));
    expect(screen.queryByRole('button', { name: 'Download Excel' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText(/Narrow the filters/)).toBeInTheDocument();
  });
});

describe('Audit retention line and log downloads', () => {
  it('shows the retention line with local-time last/next, and hides it when the server sends no meta', async () => {
    const { ds } = await boot('/settings?section=audit');
    expect(await screen.findByText(/Entries older than 14 days are removed every 2 weeks\. Last cleaned: Never\. Next: \d{2} \w{3} \d{1,2}:\d\d (AM|PM)/)).toBeInTheDocument();
    cleanup();
    vi.spyOn(ds, 'getAudit').mockImplementation(async () => ({ total: 0, limit: 50, offset: 0, has_more: false, items: [] }));
    vi.spyOn(ds, 'getAuditFacets').mockImplementation(async () => ({ categories: [], object_types: [], actions: [], sources: [] }));
    await boot('/settings?section=audit', ds);
    await screen.findByText('No audit events yet.');
    expect(screen.queryByText(/Entries older than/)).toBeNull();
  });

  it('Logging: Download logs (zip) and Download current log, the 7-day note, and the omitted note', async () => {
    const ds = newMock();
    const dl = vi.spyOn(ds, 'downloadLogs');
    const { user } = await boot('/settings', ds);
    await user.click(screen.getByRole('button', { name: /^Logging/ }));
    expect(await screen.findByText('Log files older than 7 days are removed every week.')).toBeInTheDocument();
    expect(screen.queryByText(/Older log files were omitted/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Download logs' }));
    expect(await screen.findByText('Logs downloaded')).toBeInTheDocument();
    expect(dl).toHaveBeenLastCalledWith('zip');
    dl.mockResolvedValueOnce({ blob: new Blob(['x']), filename: 'tam_logs.zip', omitted: 2 });
    await user.click(screen.getByRole('button', { name: 'Download logs' }));
    expect(await screen.findByText('Older log files were omitted (size limit).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download current log' }));
    await waitFor(() => expect(dl).toHaveBeenLastCalledWith('current'));
    expect(await screen.findByText('Current log downloaded')).toBeInTheDocument();
  });
});

describe('Backups kinds', () => {
  it('shows Weekly / Safety / Manual badges and the retention note', async () => {
    const ds = newMock();
    await ds.createBackup();
    const { user } = await boot('/settings', ds);
    await user.click(screen.getByRole('button', { name: /^Data/ }));
    const table = await screen.findByRole('table', { name: 'Most recent backups' });
    expect(within(table).getAllByText('Manual').length).toBeGreaterThan(0);
    expect(within(table).getAllByText(/^(Safety|Weekly|Manual)$/).length).toBeGreaterThan(0);
    expect(screen.getByText(/A backup is created automatically once a week; safety backups are made before imports and deletes/)).toBeInTheDocument();
  });
});

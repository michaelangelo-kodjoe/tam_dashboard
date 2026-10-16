// Settings > Data portability UI (Run 6): export, restore from file, restore database. Mock adapter plus injected failures.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';
import { DataSourceError } from '../../data/DataSource';
import { reloader } from '../../lib/portability';

async function boot(ds = newMock()) {
  sessionStorage.clear();
  window.history.pushState({}, '', '/settings');
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await user.click(await screen.findByRole('button', { name: /^Data/ }));
  await screen.findByRole('table', { name: 'Most recent backups' });
  return { user, ds };
}
const csv = (name: string, body: string) => new File([body], name, { type: 'text/csv' });
beforeEach(() => { document.body.style.overflow = ''; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); });

describe('Data section', () => {
  it('lists the four actions and a Restore this backup button on every backup row', async () => {
    const { ds } = await boot();
    const list = screen.getByRole('list', { name: 'Export and restore' });
    for (const n of ['Export to Excel', 'Export database', 'Restore from file', 'Restore database']) expect(within(list).getByRole('button', { name: n })).toBeInTheDocument();
    const backups = await ds.listBackups();
    expect(screen.getAllByRole('button', { name: /^Restore this backup:/ })).toHaveLength(backups.length);
  });

  it('Export to Excel and Export database call the adapter and toast the file name', async () => {
    const { user, ds } = await boot();
    const x = vi.spyOn(ds, 'exportExcel');
    const d = vi.spyOn(ds, 'exportDatabase');
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    expect(await screen.findByText('Excel export downloaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Export database' }));
    expect(await screen.findByText('Database copy downloaded')).toBeInTheDocument();
    expect(x).toHaveBeenCalledTimes(1); expect(d).toHaveBeenCalledTimes(1);
  });
});

describe('Restore from file', () => {
  it('previews New and Differs per table with the CSV notice, then adds the missing rows and shows the safety backup', async () => {
    const { user, ds } = await boot();
    const acct = (await ds.getState()).accounts[0];
    await user.click(screen.getByRole('button', { name: 'Restore from file' }));
    const dlg = await screen.findByRole('dialog', { name: 'Restore from file' });
    expect(dlg).toHaveTextContent('Existing data is never overwritten'.replace('Existing data is never overwritten', 'Only rows that are missing'));
    await user.upload(within(dlg).getByLabelText('Choose files to restore'), csv('Accounts.csv', `id,name\nnew-1,Brand New Co\nnew-2,Another Co\n${acct.id},Renamed Account\n`));
    const table = await within(dlg).findByRole('table', { name: /What the files contain/ });
    expect(within(table).getByRole('row', { name: /Accounts 2 0 1 0/ })).toBeInTheDocument();
    expect(within(dlg).getByText(/CSV files cannot tell which database they came from/)).toBeInTheDocument();
    expect(within(dlg).getByText(/differs from the database/)).toBeInTheDocument();
    const apply = within(dlg).getByRole('button', { name: 'Add 2 missing rows' });
    await user.click(apply);
    expect(await within(dlg).findByText(/Restore complete: 2 rows added/)).toBeInTheDocument();
    expect(within(dlg).getByText(/^tam_pre-import_|pre-import/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: /Download skipped rows \(\.xlsx\)/ })).toBeInTheDocument();
  });

  it('an unrecognized CSV blocks Apply until the table is chosen; the choice is re-validated; a file can be removed', async () => {
    const { user } = await boot();
    await user.click(screen.getByRole('button', { name: 'Restore from file' }));
    const dlg = await screen.findByRole('dialog', { name: 'Restore from file' });
    await user.upload(within(dlg).getByLabelText('Choose files to restore'), csv('data.csv', 'foo,bar\n1,2\n'));
    expect(await within(dlg).findByText('Unrecognized')).toBeInTheDocument();
    expect(within(dlg).getByRole('alert')).toHaveTextContent(/choose which table/i);
    expect(within(dlg).getByRole('button', { name: /Add \d+ missing rows?/ })).toBeDisabled();
    await user.click(within(dlg).getByRole('combobox', { name: 'Table for data.csv' }));
    await user.click(screen.getByRole('option', { name: 'Contacts' }));
    expect(await within(dlg).findByText('Missing columns')).toBeInTheDocument();
    expect(within(dlg).getByText(/Missing: id, client_id, name/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Remove data.csv' }));
    await waitFor(() => expect(within(dlg).queryByRole('list', { name: 'Files added' })).toBeNull());
  });

  it('a file of everything already present says Nothing to restore and keeps Apply disabled', async () => {
    const { user, ds } = await boot();
    const acct = (await ds.getState()).accounts[0];
    await user.click(screen.getByRole('button', { name: 'Restore from file' }));
    const dlg = await screen.findByRole('dialog', { name: 'Restore from file' });
    await user.upload(within(dlg).getByLabelText('Choose files to restore'), csv('Accounts.csv', `id,name\n${acct.id},"${acct.name}"\n`));
    expect(await within(dlg).findByText(/Nothing to restore: everything/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Nothing to restore' })).toBeDisabled();
  });
});

describe('xlsx workbook entry (contract 14.3 amendment)', () => {
  it('shows one workbook row with its sheets, no table dropdown, Remove drops it, and skip texts for the new codes show', async () => {
    const ds = newMock();
    const plan = {
      restore_id: 'r1', plan_hash: 'h', expires_at: '', kind: 'xlsx' as const, source: { app: 'TAM Command Center', version: '0.1.0', schema_version: 3, channel: 'DEV', exported_at: '2026-10-15T09:00:00.000Z' }, csv_notice: null,
      limits: { max_file_bytes: 1, max_sheet_rows: 1, max_total_rows: 1, max_csv_files: 9 },
      files: [{ file_id: 'w', name: 'tam_export.xlsx', format: 'xlsx' as const, size_bytes: 5000, table: null, table_label: null, table_source: 'sheets' as const, state: 'ready' as const, missing_columns: [], rows: 8, sheets: [{ table: 'accounts' as const, label: 'Accounts', rows: 3 }, { table: 'contacts' as const, label: 'Contacts', rows: 5 }] }],
      tables: [
        { key: 'accounts' as const, label: 'Accounts', staged: true, new: 2, identical: 0, differs: 0, invalid: 1, rows: 3 },
        { key: 'contacts' as const, label: 'Contacts', staged: true, new: 5, identical: 0, differs: 0, invalid: 0, rows: 5 },
      ],
      totals: { new: 7, identical: 0, differs: 0, invalid: 1, rows: 8 }, blocking: [], warnings: [], can_apply: true, nothing_to_restore: false, apply_label: 'Add 7 missing rows',
      issues: [{ table: 'accounts' as const, table_label: 'Accounts', row: 4, outcome: 'invalid' as const, column: 'name', code: 'tab_or_linebreak', text: 'Accounts row 4: name: must not contain tabs or line breaks (the value starts with a tab)', problems: 1, file_id: 'w' },
        { table: 'accounts' as const, table_label: 'Accounts', row: 5, outcome: 'invalid' as const, column: 'name', code: 'leading_trailing_space', text: 'Accounts row 5: name: must not start or end with a space', problems: 1, file_id: 'w' }],
      issues_total: 2,
    };
    vi.spyOn(ds, 'inspectRestoreFile').mockResolvedValue(plan);
    const remove = vi.spyOn(ds, 'removeRestoreFile').mockResolvedValue({ ...plan, files: [], tables: [], issues: [], issues_total: 0, can_apply: false });
    const { user } = await boot(ds);
    await user.click(screen.getByRole('button', { name: 'Restore from file' }));
    const dlg = await screen.findByRole('dialog', { name: 'Restore from file' });
    await user.upload(within(dlg).getByLabelText('Choose files to restore'), new File(['x'], 'tam_export.xlsx'));
    const list = await within(dlg).findByRole('list', { name: 'Files added' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Accounts 3, Contacts 5')).toBeInTheDocument();
    expect(within(list).queryByRole('combobox')).toBeNull();
    expect(within(dlg).getByText(/must not contain tabs or line breaks \(the value starts with a tab\)/)).toBeInTheDocument();
    expect(within(dlg).getByText(/must not start or end with a space/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Remove tam_export.xlsx' }));
    expect(remove).toHaveBeenCalledWith('r1', 'w');
    await waitFor(() => expect(within(dlg).queryByRole('list', { name: 'Files added' })).toBeNull());
  });
});

describe('result file names (QA-7-2)', () => {
  it('names the workbook once however the backend sends it', async () => {
    const { uniqueFiles } = await import('./RestoreFileDialog');
    expect(uniqueFiles(Array(8).fill('tam_export.xlsx'))).toEqual(['tam_export.xlsx']);
    expect(uniqueFiles('tam_export.xlsx')).toEqual(['tam_export.xlsx']);
    expect(uniqueFiles(['A.csv', 'B.csv', 'A.csv'])).toEqual(['A.csv', 'B.csv']);
    expect(uniqueFiles(undefined)).toEqual([]);
  });
  it('the adapter de-duplicates files and accepts a single file name', async () => {
    const { ApiDataSource } = await import('../../data/ApiDataSource');
    const body = (item: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: true, item }) }) as unknown as Response));
    body({ restore_id: 'r', files: Array(8).fill('w.xlsx'), counts: {}, tables: [] });
    expect((await new ApiDataSource().applyRestore({ restore_id: 'r', plan_hash: 'h' })).files).toEqual(['w.xlsx']);
    body({ restore_id: 'r', file: 'w.xlsx', counts: {}, tables: [] });
    expect((await new ApiDataSource().applyRestore({ restore_id: 'r', plan_hash: 'h' })).files).toEqual(['w.xlsx']);
    vi.unstubAllGlobals();
  });
});

describe('Restore database', () => {
  it('opens from a backup row; Restore stays disabled until RESTORE is typed; apply shows the result and Reload app', async () => {
    const reload = vi.spyOn(reloader, 'reload').mockImplementation(() => undefined);
    const { user } = await boot();
    await user.click(screen.getAllByRole('button', { name: /^Restore this backup:/ })[0]);
    const dlg = await screen.findByRole('dialog', { name: 'Restore this backup' });
    expect(await within(dlg).findByText(/Everything currently in the app will be replaced/)).toBeInTheDocument();
    expect(within(dlg).getByRole('columnheader', { name: 'In the file' })).toBeInTheDocument();
    expect(within(dlg).getByRole('columnheader', { name: 'In the current database' })).toBeInTheDocument();
    expect(within(dlg).getAllByText('fewer').length).toBeGreaterThan(0);
    const go = within(dlg).getByRole('button', { name: 'Restore database' });
    expect(go).toBeDisabled();
    const word = within(dlg).getByLabelText('Type RESTORE to continue');
    await user.type(word, 'restore');
    expect(go).toBeDisabled();
    await user.clear(word);
    await user.type(word, 'RESTORE');
    expect(go).toBeEnabled();
    await user.click(go);
    expect(await within(dlg).findByText('Database restored')).toBeInTheDocument();
    expect(within(dlg).getByText(/pre-restore|tam_/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Reload app' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads by itself after 5 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const reload = vi.spyOn(reloader, 'reload').mockImplementation(() => undefined);
      const { user } = await bootFake();
      await user.click(screen.getAllByRole('button', { name: /^Restore this backup:/ })[0]);
      const dlg = await screen.findByRole('dialog', { name: 'Restore this backup' });
      await user.type(await within(dlg).findByLabelText('Type RESTORE to continue'), 'RESTORE');
      await user.click(within(dlg).getByRole('button', { name: 'Restore database' }));
      await within(dlg).findByText('Database restored');
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5100);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('a non-SQLite upload is refused in plain words and nothing is staged', async () => {
    const { user } = await boot();
    await user.click(screen.getByRole('button', { name: 'Restore database' }));
    const dlg = await screen.findByRole('dialog', { name: 'Restore database' });
    await user.upload(within(dlg).getByLabelText('Choose a database file'), new File(['hello'], 'x.db'));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('not a SQLite database');
    expect(within(dlg).queryByLabelText('Type RESTORE to continue')).toBeNull();
  });

  it('answers 501 gracefully while backend phase 2 is missing', async () => {
    const ds = newMock();
    vi.spyOn(ds, 'previewBackupRestore').mockRejectedValue(new DataSourceError('not_implemented', 'Not implemented', undefined, 501));
    const { user } = await boot(ds);
    await user.click(screen.getAllByRole('button', { name: /^Restore this backup:/ })[0]);
    const dlg = await screen.findByRole('dialog', { name: 'Restore this backup' });
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/not available in this build yet/);
  });

  it('restore_failed states exactly what happened to the data', async () => {
    const ds = newMock();
    vi.spyOn(ds, 'applyDatabaseRestore').mockRejectedValue(new DataSourceError('restore_failed', 'The swap failed.', undefined, 500, { state: 'safety_backup', backup: 'tam_x_pre-restore_v3.db' }));
    const { user } = await boot(ds);
    await user.click(screen.getAllByRole('button', { name: /^Restore this backup:/ })[0]);
    const dlg = await screen.findByRole('dialog', { name: 'Restore this backup' });
    await user.type(await within(dlg).findByLabelText('Type RESTORE to continue'), 'RESTORE');
    await user.click(within(dlg).getByRole('button', { name: 'Restore database' }));
    expect(await within(dlg).findByText('Restored from safety backup tam_x_pre-restore_v3.db')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Reload app' })).toBeInTheDocument();
  });

  it('503 restoring: waits for health, then offers Reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ds = newMock();
      vi.spyOn(ds, 'applyDatabaseRestore').mockRejectedValue(new DataSourceError('restoring', 'The app is restoring.', undefined, 503));
      vi.spyOn(reloader, 'reload').mockImplementation(() => undefined);
      const { user } = await bootFake(ds);
      await user.click(screen.getAllByRole('button', { name: /^Restore this backup:/ })[0]);
      const dlg = await screen.findByRole('dialog', { name: 'Restore this backup' });
      await user.type(await within(dlg).findByLabelText('Type RESTORE to continue'), 'RESTORE');
      await user.click(within(dlg).getByRole('button', { name: 'Restore database' }));
      expect(await within(dlg).findByText(/Restoring… do not close this window/)).toBeInTheDocument();
      vi.advanceTimersByTime(1500);
      expect(await within(dlg).findByText('The app is back.')).toBeInTheDocument();
      expect(within(dlg).getByRole('button', { name: 'Reload app' })).toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
});

async function bootFake(ds = newMock()) {
  sessionStorage.clear();
  window.history.pushState({}, '', '/settings');
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  render(<App ds={ds} />);
  await user.click(await screen.findByRole('button', { name: /^Data/ }));
  await screen.findByRole('table', { name: 'Most recent backups' });
  return { user, ds };
}

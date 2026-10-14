import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataProvider } from '../../store/DataContext';
import { ToastProvider } from '../ui/Toast';
import { newMock } from '../../data/mock/testFile';
import { DataSourceError } from '../../data/DataSource';
import { ImportWizard } from './ImportWizard';

const H = 'Account name,BPID,Products,Status,Next contact date,Notes\n';
const SAMPLE =
  H +
  'Ashgrove Capital Partners,210551,Terminal,Active,2026-11-02,\n' +
  'Halvorsen Fjord Asset Mgmt,,,,,Oslo\n' +
  'Linden Row Pensions,330918,,Dormant,,\n' +
  'Quillfeather Advisory,,,,,\n' +
  'Quillfeather Advisory Group,,,,,x\n';

beforeEach(() => { document.body.style.overflow = ''; });
afterEach(() => cleanup());

async function open(ds = newMock(), onClose = vi.fn()) {
  const user = userEvent.setup();
  const view = render(<ToastProvider><DataProvider ds={ds}><ImportWizard onClose={onClose} /></DataProvider></ToastProvider>);
  return { user, ds, onClose, view };
}
async function choose(user: ReturnType<typeof userEvent.setup>, text = SAMPLE, name = 'accounts.csv') {
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  await user.upload(input, new File([text], name, { type: 'text/csv' }));
}
const dlg = () => screen.getByRole('dialog', { name: 'Import accounts' });
const foot = (name: RegExp | string) => within(dlg()).getByRole('button', { name });
async function toReview(user: ReturnType<typeof userEvent.setup>) {
  await choose(user);
  await screen.findByRole('group', { name: 'Chosen file' });
  await user.click(foot('Preview'));
  await user.click(await within(dlg()).findByRole('button', { name: /Review 2 duplicates/ }));
  await within(dlg()).findByText(/0 of 2 resolved/);
}

describe('import wizard: steps and states', () => {
  it('starts on Choose file: step list with aria-current, drop area, both templates, Preview disabled until a file was read', async () => {
    await open();
    const steps = within(dlg()).getByRole('list', { name: 'Import steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((i) => i.textContent?.replace(/\d/, '').trim())).toEqual(['Choose file', 'Preview', 'Review duplicates', 'Result']);
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items.filter((i) => i.hasAttribute('aria-current'))).toHaveLength(1);
    expect(within(dlg()).getByRole('group', { name: 'File drop area' })).toBeInTheDocument();
    expect(within(dlg()).getByText(/Drop an \.xlsx or \.csv file here/)).toBeInTheDocument();
    expect(within(dlg()).getByRole('button', { name: 'Download .xlsx template' })).toBeInTheDocument();
    expect(within(dlg()).getByRole('button', { name: 'Download .csv template' })).toBeInTheDocument();
    expect(foot('Preview')).toBeDisabled();
    expect(within(dlg()).getByRole('button', { name: 'choose a file' })).toHaveFocus(); // initial focus is inside the dialog
  });

  it('a read file shows rows found, size and format; Remove goes back to the drop area', async () => {
    const { user } = await open();
    await choose(user);
    const card = await screen.findByRole('group', { name: 'Chosen file' });
    expect(card).toHaveTextContent('accounts.csv');
    expect(card).toHaveTextContent('5 rows read as CSV (UTF-8, comma separated)');
    expect(foot('Preview')).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('group', { name: 'File drop area' })).toBeInTheDocument();
    expect(foot('Preview')).toBeDisabled();
  });

  it('refused files show the clear message in place and keep Preview disabled', async () => {
    const { user } = await open();
    await choose(user, 'x', 'notes.csv'.replace('.csv', '.csv'));
    // binary content named .csv
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    await user.upload(input, new File([new Uint8Array([1, 2, 0, 3])], 'photo.csv', { type: 'text/csv' }));
    expect(await within(dlg()).findByRole('alert')).toHaveTextContent('This file is not a spreadsheet or a CSV text file.');
    expect(foot('Preview')).toBeDisabled();
  });

  it('Preview: five tiles from counts, Unchanged shown, filters, row table, "Nothing has been written yet"', async () => {
    const { user } = await open();
    await choose(user);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(foot('Preview'));
    const counts = await within(dlg()).findByRole('group', { name: 'Counts' });
    const tile = (label: string) => within(counts).getByText(label).parentElement!.textContent;
    expect(tile('Valid')).toMatch(/^Valid4of 5 rows/);
    expect(tile('New')).toMatch(/^New2/);
    expect(tile('Needs review')).toMatch(/^Needs review2/);
    expect(tile('Invalid')).toMatch(/^Invalid1/);
    expect(within(dlg()).getByText(/Nothing has been written yet/)).toBeInTheDocument();
    const table = within(dlg()).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5);
    await user.click(within(dlg()).getByRole('radio', { name: /Invalid 1/ }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText(/Status: 'Dormant' is not in the list \(Active, Inactive\)\. This row will be skipped/)).toBeInTheDocument();
    expect(within(dlg()).getByRole('button', { name: /Review 2 duplicates/ })).toBeEnabled();
  });

  it('Review: progress "N of M resolved", nothing preselected, Apply disabled until all resolved, then Result with backup, audit note and skipped download', async () => {
    const { user, ds } = await open();
    await toReview(user);
    const apply = foot('Apply import');
    expect(apply).toBeDisabled();
    const group = () => within(dlg()).getByRole('radiogroup', { name: /Decision for row/ });
    expect(within(group()).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    expect(within(dlg()).getByRole('navigation', { name: 'Rows to review' })).toBeInTheDocument();
    await user.click(within(group()).getByRole('radio', { name: 'Same account' }));
    expect(await within(dlg()).findByText(/1 of 2 resolved/)).toBeInTheDocument();
    expect(apply).toBeDisabled();
    await user.click(within(dlg()).getByRole('button', { name: /Quillfeather Advisory Group/ }));
    expect(within(dlg()).getByText(/Row 5 in this file/) || true).toBeTruthy();
    await user.click(within(group()).getByRole('radio', { name: 'Skip' }));
    expect(await within(dlg()).findByText(/2 of 2 resolved/)).toBeInTheDocument();
    expect(apply).toBeEnabled();
    await user.click(apply);
    const done = await within(dlg()).findByRole('group', { name: 'Result counts' });
    expect(done).toHaveTextContent(/Created2/);
    expect(done).toHaveTextContent(/Overwritten0/);
    expect(dlg()).toHaveTextContent(/pre-import/);
    expect(dlg()).toHaveTextContent(/events recorded with source Bulk Import/);
    expect(dlg()).toHaveTextContent(/All changes written together/);
    const skipped = within(dlg()).getByRole('table');
    expect(within(skipped).getByText(/Skipped by you/)).toBeInTheDocument();
    expect(within(skipped).getByText(/Invalid: Status: 'Dormant'/)).toBeInTheDocument();
    expect(within(dlg()).getByRole('button', { name: /Download skipped rows \(\.csv\)/ })).toBeInTheDocument();
    expect(within(dlg()).queryByRole('button', { name: /instead/ })).toBeNull(); // only the upload's format is offered
    expect(within(dlg()).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect((await ds.getState()).accounts.some((a) => a.name === 'Ashgrove Capital Partners')).toBe(true);
  });

  it('with several candidates "Same account" is not resolved until one is picked', async () => {
    const { user } = await open();
    await choose(user, `${H}Pinecrest Shoal Fund,,,,,\nPinecrest Shoal Municipal,,,,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(foot('Preview'));
    await user.click(await within(dlg()).findByRole('button', { name: /Review \d duplicates?/ }));
    const g = () => within(dlg()).getByRole('radiogroup', { name: /Decision for row/ });
    await user.click(within(dlg()).getByRole('button', { name: /Pinecrest Shoal Municipal Row/ })); // row 3 has the existing account and row 2 as candidates
    await user.click(within(g()).getByRole('radio', { name: 'Same account' }));
    const which = await within(dlg()).findByRole('radiogroup', { name: /Which account is row/ });
    expect(within(dlg()).getByText(/0 of \d resolved/)).toBeInTheDocument();
    await user.click(within(which).getAllByRole('radio')[0]);
    expect(within(dlg()).getByText(/1 of \d resolved/)).toBeInTheDocument();
  });

  it('arrow keys move through the three decisions (radiogroup semantics)', async () => {
    const { user } = await open();
    await toReview(user);
    const same = within(dlg()).getByRole('radio', { name: 'Same account' });
    same.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(dlg()).getByRole('radio', { name: 'Different account' })).toHaveAttribute('aria-checked', 'true');
    expect(within(dlg()).getByRole('radio', { name: 'Different account' })).toHaveFocus();
  });

  it('no percentage, score or similarity number appears anywhere in the wizard text', async () => {
    const { user } = await open();
    await toReview(user);
    const t = dlg().textContent ?? '';
    expect(t).not.toMatch(/\d\s?%/);
    expect(t).not.toMatch(/similarity|score/i);
    expect(t).toMatch(/High match|Medium match|Low match/);
  });
});

describe('import wizard: errors, keyboard and the discard guard', () => {
  it('import_expired shows the timeout message and offers to choose the file again', async () => {
    const { user, ds } = await open();
    await toReview(user);
    vi.spyOn(ds, 'applyAccountsImport').mockRejectedValue(new DataSourceError('import_expired', 'gone', undefined, 410));
    const g = () => within(dlg()).getByRole('radiogroup', { name: /Decision for row/ });
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    await user.click(within(dlg()).getByRole('button', { name: /Quillfeather Advisory Group/ }));
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    await user.click(foot('Apply import'));
    expect(await within(dlg()).findByRole('alert')).toHaveTextContent('This import timed out. Choose the file again.');
    await user.click(foot('Choose the file again'));
    expect(screen.getByRole('group', { name: 'File drop area' })).toBeInTheDocument();
  });

  it('preview_stale refreshes the plan, keeps decisions for unchanged rows and says so', async () => {
    const { user, ds } = await open();
    await toReview(user);
    const g = () => within(dlg()).getByRole('radiogroup', { name: /Decision for row/ });
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    await user.click(within(dlg()).getByRole('button', { name: /Quillfeather Advisory Group/ }));
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    vi.spyOn(ds, 'applyAccountsImport').mockRejectedValueOnce(new DataSourceError('preview_stale', 'stale', undefined, 409, { changed: [] }));
    await user.click(foot('Apply import'));
    const note = await within(dlg()).findByText(/Accounts changed since you opened the preview/);
    expect(note).toHaveTextContent(/Your decisions were kept/);
    expect(within(dlg()).getByText(/2 of 2 resolved/)).toBeInTheDocument();
    expect(foot('Apply import')).toBeEnabled();
  });

  it('unresolved_duplicates from the server returns to Review with the rows named', async () => {
    const { user, ds } = await open();
    await toReview(user);
    const g = () => within(dlg()).getByRole('radiogroup', { name: /Decision for row/ });
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    await user.click(within(dlg()).getByRole('button', { name: /Quillfeather Advisory Group/ }));
    await user.click(within(g()).getByRole('radio', { name: 'Skip' }));
    vi.spyOn(ds, 'applyAccountsImport').mockRejectedValueOnce(new DataSourceError('unresolved_duplicates', 'x', undefined, 409, { rows: [3] }));
    await user.click(foot('Apply import'));
    expect(await within(dlg()).findByRole('alert')).toHaveTextContent('1 similar row still needs a decision: row 3.');
  });

  it('Escape asks before discarding once a file was read; "Keep working" keeps it, "Discard import" closes', async () => {
    const { user, onClose } = await open();
    await choose(user);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard this import?' });
    expect(onClose).not.toHaveBeenCalled();
    expect(within(confirm).getByRole('button', { name: 'Keep working' })).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'Keep working' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('group', { name: 'Chosen file' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Discard import' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes straight away before any file was read, and on the Result page', async () => {
    const a = await open();
    await a.user.keyboard('{Escape}');
    expect(a.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const { user, onClose } = await open();
    await choose(user, `${H}Zzyzx Unique Holdings,,,,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(foot('Preview'));
    await user.click(await within(dlg()).findByRole('button', { name: 'Apply import' }));
    await within(dlg()).findByRole('group', { name: 'Result counts' });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with nothing flagged Preview applies directly (Review is skipped) and focus moves to the Preview heading on the way', async () => {
    const { user } = await open();
    await choose(user, `${H}Zzyzx Unique Holdings,,,,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(foot('Preview'));
    expect(await within(dlg()).findByRole('heading', { name: 'Preview' })).toHaveFocus();
    expect(within(dlg()).queryByRole('button', { name: /Review \d+ duplicate/ })).toBeNull();
    await user.click(within(dlg()).getByRole('button', { name: 'Apply import' }));
    await waitFor(() => expect(within(dlg()).getByRole('heading', { name: /Import applied/ })).toHaveFocus());
  });

  it('a file where no row is valid cannot be applied', async () => {
    const { user } = await open();
    await choose(user, `${H}Bad,,,Dormant,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(foot('Preview'));
    expect(await within(dlg()).findByRole('button', { name: 'Apply import' })).toBeDisabled();
    expect(within(dlg()).getByText(/No row can be imported/)).toBeInTheDocument();
  });
});

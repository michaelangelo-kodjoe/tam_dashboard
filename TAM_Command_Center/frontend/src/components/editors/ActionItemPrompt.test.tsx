// Action items on a saved note -> "Create a task from this action item?" (one prompt per line).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';
import { parseActionItems, prefillFor } from '../../lib/actionItems';

async function boot(path: string, ds = newMock()) {
  window.history.pushState({}, '', path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { user, ds };
}
afterEach(() => cleanup());

async function accountId(ds = newMock()) {
  const a = (await ds.getState()).accounts.find((x) => x.name.startsWith('Halvorsen'))!;
  return a;
}
async function fillNote(user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, subject: string, actions: string) {
  await user.type(within(dlg).getByLabelText('Subject'), subject);
  await user.type(within(dlg).getByLabelText('Body'), 'Discussed things');
  if (actions) await user.type(within(dlg).getByLabelText('Action items'), actions);
}

describe('parser', () => {
  it('one item per non-empty line; bullets and numbers removed', () => {
    expect(parseActionItems('- Send recap\n\n* Book review\n1. Update plan\n2) Call desk\n[ ] Check')).toEqual(['Send recap', 'Book review', 'Update plan', 'Call desk', 'Check']);
    expect(parseActionItems('  ')).toEqual([]);
    expect(parseActionItems(null)).toEqual([]);
  });
  it('long action text is truncated in the title and kept in full in Notes', () => {
    const long = 'x'.repeat(700);
    const p = prefillFor(long, 'Meeting Note, 2026-10-17', 'c1', { index: 0, total: 1 });
    expect(p.task.length).toBeLessThanOrEqual(500);
    expect(p.task.endsWith('…')).toBe(true);
    expect(p.notes).toBe(`From note: Meeting Note, 2026-10-17\n\n${long}`);
    expect(prefillFor('Short', 'S, 2026-10-17', 'c1', { index: 1, total: 3 })).toMatchObject({ task: 'Short', notes: 'From note: S, 2026-10-17', label: 'Action item 2 of 3' });
  });
});

describe('prompt after saving a note', () => {
  it('appears only with action items; the note is saved either way; No does nothing', async () => {
    const ds = newMock();
    const a = await accountId(ds);
    const { user } = await boot(`/accounts/${a.id}/activity?note=new&type=General%20Note`, ds);
    let dlg = await screen.findByRole('dialog');
    await fillNote(user, dlg, 'No actions here', '');
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // with action items
    window.history.pushState({}, '', `/accounts/${a.id}/activity?note=new&type=General%20Note`);
    cleanup();
    await boot(`/accounts/${a.id}/activity?note=new&type=General%20Note`, ds);
    dlg = await screen.findByRole('dialog');
    await fillNote(user, dlg, 'With actions', 'Send the recap to the desk');
    const before = (await ds.getTasks({})).length;
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    const ask = await screen.findByRole('alertdialog', { name: 'Create a task from this action item?' });
    expect(ask).toHaveTextContent('Send the recap to the desk');
    expect(ask).toHaveTextContent(a.name);
    expect(within(ask).getByRole('button', { name: 'No' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((await ds.getTasks({})).length).toBe(before);
    expect((await ds.getActivity(a.id, { filter: 'all', limit: 100 })).items.some((e) => e.note.subject === 'With actions')).toBe(true);
  }, 40000);

  it('Yes opens the new-task drawer for the same account, prefilled from the action item and the note', async () => {
    const ds = newMock();
    const a = await accountId(ds);
    const { user } = await boot(`/accounts/${a.id}/activity?note=new&type=Meeting%20Note`, ds);
    const dlg = await screen.findByRole('dialog');
    await fillNote(user, dlg, 'Weekly sync', '- Send the recap to the desk');
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    const ask = await screen.findByRole('alertdialog');
    await user.click(within(ask).getByRole('button', { name: 'Yes, create task' }));
    const drawer = await screen.findByRole('dialog', { name: /New task/ });
    expect(within(drawer).getByLabelText(/^Task/)).toHaveValue('Send the recap to the desk');
    expect((within(drawer).getByLabelText('Notes') as HTMLTextAreaElement).value).toMatch(/^From note: Weekly sync, \d{4}-\d{2}-\d{2}$/);
    expect(within(drawer).getByDisplayValue(a.name)).toBeInTheDocument();
    const before = (await ds.getTasks({})).length;
    await user.click(within(drawer).getByRole('button', { name: /^Save/ }));
    await waitFor(async () => expect((await ds.getTasks({})).length).toBe(before + 1));
    const t = (await ds.getTasks({})).find((x) => x.task === 'Send the recap to the desk')!;
    expect(t.client_id).toBe(a.id);
  }, 40000);

  it('several lines are asked one after another with "Action item N of M"', async () => {
    const ds = newMock();
    const a = await accountId(ds);
    const { user } = await boot(`/accounts/${a.id}/activity?note=new&type=Call%20Note`, ds);
    const dlg = await screen.findByRole('dialog');
    await fillNote(user, dlg, 'Call', 'First thing{Enter}Second thing{Enter}Third thing');
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    let ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('First thing');
    expect(ask).toHaveTextContent('Action item 1 of 3');
    await user.click(within(ask).getByRole('button', { name: 'No' }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Second thing'));
    ask = screen.getByRole('alertdialog');
    expect(ask).toHaveTextContent('Action item 2 of 3');
    await user.click(within(ask).getByRole('button', { name: 'Yes, create task' }));
    const drawer = await screen.findByRole('dialog', { name: /Action item 2 of 3/ });
    expect(within(drawer).getByLabelText(/^Task/)).toHaveValue('Second thing');
    await user.click(within(drawer).getByRole('button', { name: /^Cancel/ }));
    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveTextContent('Third thing'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'No' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  }, 60000);

  it('editing a note whose action items did not change does not prompt', async () => {
    const ds = newMock();
    const a = await accountId(ds);
    const created = await ds.saveNote({ client_id: a.id, note_type: 'General Note', timestamp: new Date().toISOString(), subject: 'Old', body: 'b', action_items: 'Do the thing' });
    const { user } = await boot(`/accounts/${a.id}/activity?note=${created.item.id}`, ds);
    const dlg = await screen.findByRole('dialog');
    const subject = await within(dlg).findByLabelText('Subject');
    await user.clear(subject);
    await user.type(subject, 'Edited subject');
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  }, 40000);

  it('Quick Capture: a note with action items prompts after saving', async () => {
    const ds = newMock();
    const a = await accountId(ds);
    const { user } = await boot(`/accounts/${a.id}/overview`, ds);
    await user.click(screen.getByRole('button', { name: /Capture/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Quick capture' });
    await user.click(within(dlg).getByRole('radio', { name: 'General note' }));
    await user.type(within(dlg).getByLabelText('Subject'), 'Quick one');
    await user.type(within(dlg).getByLabelText('Body'), 'text');
    await user.type(within(dlg).getByLabelText('Action items'), 'Follow up on the quick one');
    await user.click(within(dlg).getByRole('button', { name: /^Save/ }));
    const ask = await screen.findByRole('alertdialog', { name: 'Create a task from this action item?' });
    expect(ask).toHaveTextContent('Follow up on the quick one');
    await user.click(within(ask).getByRole('button', { name: 'No' }));
  }, 40000);
});

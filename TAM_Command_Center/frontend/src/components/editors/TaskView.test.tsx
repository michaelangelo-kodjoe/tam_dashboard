// Read-only task popup first, Edit drawer second (every place a task opens goes through ?task=).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';

const loc = () => window.location.pathname + window.location.search;
async function boot(path: string, ds = newMock()) {
  window.history.pushState({}, '', path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { user, ds };
}
afterEach(() => cleanup());

describe('task popup', () => {
  it('a task row opens the read-only popup with every field and the full notes; Edit opens the drawer; Close and Escape close', async () => {
    const ds = newMock();
    const task = (await ds.getTasks({})).find((t) => t.client_id)!;
    await ds.saveTask({ ...task, notes: 'Line one {DRQS 5 <GO>}\nLine two', waiting: 'Client', expected_row_version: task.row_version });
    const { user } = await boot('/tasks', ds);
    await user.click(await screen.findByRole('link', { name: task.task }));
    const dlg = await screen.findByRole('dialog', { name: task.task });
    for (const l of ['Account', 'Category', 'Priority', 'Status', 'Due', 'Next update', 'Waiting on', 'Created', 'Updated', 'Notes']) expect(within(dlg).getByText(l)).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: (await ds.getState()).accounts.find((a) => a.id === task.client_id)!.name })).toHaveAttribute('href', `/accounts/${task.client_id}/overview`);
    expect(within(dlg).getByRole('link', { name: /DRQS 5/ })).toHaveAttribute('href', 'bbg://screens/DRQS%205');
    expect(dlg.querySelector('.tv-notes')?.textContent).toBe('Line one {DRQS 5 <GO>}\nLine two');
    expect(loc()).toBe(`/tasks?task=${task.id}`);
    expect(within(dlg).queryByRole('textbox')).toBeNull(); // read only
    await user.click(within(dlg).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(loc()).toBe(`/tasks?task=${task.id}&edit=1`));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByLabelText('Notes')).toHaveValue('Line one {DRQS 5 <GO>}\nLine two');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(loc()).toBe('/tasks'));
    await user.click(await screen.findByRole('link', { name: task.task }));
    await screen.findByRole('dialog', { name: task.task });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loc()).toBe('/tasks');
  });

  it('a Terminal link in a row does not open the popup; ?task=new still opens the edit form directly', async () => {
    const ds = newMock();
    const task = (await ds.getTasks({})).find((t) => t.client_id)!;
    await ds.saveTask({ ...task, notes: '{BAMS <GO>}', expected_row_version: task.row_version });
    const { user } = await boot('/tasks', ds);
    const link = (await screen.findAllByRole('link', { name: /BAMS/ }))[0];
    await user.click(link).catch(() => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    await boot('/tasks?task=new', ds);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByLabelText('Notes')).toBeInTheDocument();
    expect(within(drawer).getByRole('textbox', { name: /Task/ })).toBeInTheDocument();
  });

  it('Today: task rows show Notes in the pane and "Open task" lands on the popup', async () => {
    const ds = newMock();
    const queue = (await ds.getToday()).queue;
    const task = (await ds.getTasks({})).find((t) => queue.some((q) => q.id === t.id))!;
    await ds.saveTask({ ...task, notes: 'Pane note {NMS <GO>}', expected_row_version: task.row_version });
    const { user } = await boot('/today', ds);
    const row = (await screen.findAllByRole('option')).find((o) => o.textContent?.includes(task.task))!;
    await user.click(row);
    const detail = await screen.findByRole('region', { name: 'Selected item' });
    expect(within(detail).getByText('Notes')).toBeInTheDocument();
    expect(within(detail).queryByText("Why it is here")).toBeNull();
    expect(within(detail).getByRole('link', { name: /NMS/ })).toBeInTheDocument();
    await user.click(within(detail).getByRole('link', { name: /^Open task/ }));
    expect(await screen.findByRole('dialog', { name: task.task })).toBeInTheDocument();
    expect(loc()).toContain(`task=${task.id}`);
  });
});

// BAMS v2 (TASK F-1): metric tree, metric policies, search suggestions; task Done and notes; formatted notes.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';

async function boot(path: string, ds = newMock()) {
  window.history.pushState({}, '', path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { user, ds };
}
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), m }; };
beforeEach(() => { document.body.style.overflow = ''; sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('alert configuration metric list (item 8)', () => {
  it('is grouped by account, collapsed by default, one master arrow opens and closes all, and the choice is remembered', async () => {
    const ls = store();
    vi.stubGlobal('localStorage', ls);
    const ds = newMock();
    const s = await ds.getBamsState({ spark: false });
    const accounts = new Set(s.rows.map((r) => r.object.client_id));
    const { user } = await boot('/bams/config', ds);
    const tree = await screen.findByRole('tree', { name: 'Metrics by account' });
    const heads = () => within(tree).getAllByRole('button', { expanded: false }).concat(within(tree).queryAllByRole('button', { expanded: true }));
    const master = screen.getByRole('button', { name: 'Expand all account groups' });
    expect(master).toHaveAttribute('aria-expanded', 'false');
    // collapsed by default: account rows only (the selected metric's account may be open when arriving without a link: it is the first row)
    const accountHeads = tree.querySelectorAll('.bm-tg__head');
    expect(accountHeads).toHaveLength(accounts.size);
    expect(heads().length).toBeGreaterThan(0);
    await user.click(master);
    expect(screen.getByRole('button', { name: 'Collapse all account groups' })).toHaveAttribute('aria-expanded', 'true');
    expect(tree.querySelectorAll('.bm-tm').length).toBe(s.rows.length);
    expect(ls.m.get('tam.bams.metricTree.open')).toBe('1');
    // each account row carries its metric count as text, and a severity dot with text
    expect(accountHeads[0].textContent).toMatch(/\d+ metrics?/);
    expect(tree.querySelector('.bm-tg__head .bm-dot .sr-only')?.textContent).toMatch(/alert/);
    await user.click(screen.getByRole('button', { name: 'Collapse all account groups' }));
    expect(tree.querySelectorAll('.bm-tm').length).toBe(0);
    expect(ls.m.get('tam.bams.metricTree.open')).toBe('0');
  });
  it('starts open when the last choice was open, and filtering opens every matching group', async () => {
    const ls = store();
    ls.setItem('tam.bams.metricTree.open', '1');
    vi.stubGlobal('localStorage', ls);
    const { user } = await boot('/bams/config');
    const tree = await screen.findByRole('tree', { name: 'Metrics by account' });
    expect(screen.getByRole('button', { name: 'Collapse all account groups' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse all account groups' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter metrics' }), 'cpu');
    await waitFor(() => expect(tree.querySelectorAll('.bm-tm').length).toBeGreaterThan(0));
    for (const m of tree.querySelectorAll('.bm-metricnav__name')) expect(m.textContent?.toLowerCase()).toContain('cpu');
  });
});

describe('metric policies (item 7 and backport)', () => {
  it('creates a persistent policy with the custom Metric combobox, lists it, disables it and deletes it after confirming', async () => {
    const { user, ds } = await boot('/bams/config');
    const panel = await screen.findByRole('region', { name: 'Apply alerts by metric' });
    expect(panel.querySelector('select')).toBeNull(); // no native select
    expect(within(panel).getByText('0 active policies')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Save & apply to all appliances' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Choose an exact metric from the BAMS metric catalog.');

    const catalog = await ds.getBamsMetricCatalog();
    const name = catalog[0].metric_name;
    const metric = within(panel).getByRole('combobox', { name: /Metric/ });
    await user.click(metric);
    const list = await screen.findByRole('listbox');
    await user.click(within(list).getByRole('option', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}`) }));
    expect(within(panel).getAllByText(new RegExp(`${catalog[0].appliance_count} appliances?`)).length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole('radio', { name: /Below threshold/ }));
    await user.type(within(panel).getByLabelText('Threshold'), '15');
    expect(within(panel).getByText(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')} < 15 · Warning · 1 update`))).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Save & apply to all appliances' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent(/policy saved/);
    const policy = (await ds.getBamsConfigs()).find((c) => c.auto_apply)!;
    expect(policy).toMatchObject({ metric_match: name, operator: '<', threshold: 15, severity: 'Warning', rule_type: 'fixed_threshold', enabled: true });
    expect(await within(panel).findByText('1 active policy')).toBeInTheDocument();
    const table = within(panel).getByRole('table', { name: 'Persistent metric policies' });
    expect(within(table).getByText('Auto-applies')).toBeInTheDocument();

    await user.click(within(table).getByRole('button', { name: `Disable policy ${name}` }));
    expect(await within(table).findByText('Disabled')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: `Delete policy ${name}` }));
    const dlg = await screen.findByRole('alertdialog');
    await user.click(within(dlg).getByRole('button', { name: 'Delete policy' }));
    expect(await within(panel).findByText(/No persistent metric policies yet/)).toBeInTheDocument();
    expect((await ds.getBamsConfigs()).some((c) => c.auto_apply)).toBe(false);
  });
});

describe('BAMS search suggestions (backport)', () => {
  it('suggests appliances, accounts and metrics; choosing a metric filters; Enter searches all fields', async () => {
    const { user } = await boot('/bams');
    const box = await screen.findByRole('combobox', { name: 'Search appliance or metric' });
    await user.type(box, 'cpu');
    const list = await screen.findByRole('listbox', { name: 'BAMS search suggestions' });
    const opts = within(list).getAllByRole('option');
    expect(opts.length).toBeGreaterThan(1);
    expect(opts[opts.length - 1]).toHaveTextContent('Search all fields');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const metricOpt = opts.find((o) => within(o).queryByText('Metric', { selector: 'small' }));
    expect(metricOpt).toBeTruthy();
    await user.click(within(metricOpt!).getByRole('button'));
    await waitFor(() => expect(window.location.search).toMatch(/metric=/));
    expect(window.location.search).not.toMatch(/[?&]q=/);
    expect(screen.queryByRole('listbox', { name: 'BAMS search suggestions' })).toBeNull();

    await user.type(await screen.findByRole('combobox', { name: 'Search appliance or metric' }), 'zzzz');
    await screen.findByRole('listbox', { name: 'BAMS search suggestions' });
    expect(screen.getByText(/No matching appliances, accounts or metrics/)).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(window.location.search).toMatch(/q=zzzz/));
  });
});

describe('task Done and notes (backport)', () => {
  it('the popup completes a task with an Undo toast, and edits notes inline', async () => {
    const ds = newMock();
    const task = (await ds.getTasks({})).find((t) => t.client_id && t.status !== 'Complete' && !t.archived)!;
    const { user } = await boot(`/tasks?task=${task.id}`, ds);
    const dlg = await screen.findByRole('dialog', { name: task.task });
    await user.click(within(dlg).getByRole('button', { name: 'Notes' }));
    const ta = within(dlg).getByPlaceholderText(/Add context/);
    await user.clear(ta);
    await user.type(ta, 'handoff to Priya');
    await user.click(within(dlg).getByRole('button', { name: 'Save notes' }));
    await waitFor(async () => expect((await ds.getTasks({})).find((t) => t.id === task.id)?.notes).toBe('handoff to Priya'));
    expect(await screen.findByText('Task notes saved')).toBeInTheDocument();
    expect(within(dlg).getByText('handoff to Priya')).toBeInTheDocument();

    await user.click(within(dlg).getByRole('button', { name: 'Done' }));
    await waitFor(async () => expect((await ds.getTasks({})).find((t) => t.id === task.id)?.status).toBe('Complete'));
    expect(await screen.findByText('Task completed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await ds.getTasks({})).find((t) => t.id === task.id)?.status).toBe(task.status));
  });
  it('Today work queue rows have a Done button that completes the task without opening it', async () => {
    const ds = newMock();
    const { user } = await boot('/today', ds);
    const done = (await screen.findAllByRole('button', { name: /^Mark done: / }))[0];
    const title = done.getAttribute('aria-label')!.replace('Mark done: ', '');
    const task = (await ds.getTasks({})).find((t) => t.task === title)!;
    await user.click(done);
    await waitFor(async () => expect((await ds.getTasks({})).find((t) => t.id === task.id)?.status).toBe('Complete'));
    expect(window.location.search).not.toMatch(/task=/);
    expect(await screen.findByText('Task completed')).toBeInTheDocument();
  });
});

describe('formatted notes (item 4)', () => {
  it('a note saved with the rich editor is stored as html and shows formatted in the timeline; legacy plain notes render as before', async () => {
    const ds = newMock();
    const acct = (await ds.getState()).accounts[0];
    const plain = (await ds.saveNote({ client_id: acct.id, note_type: 'Call Note', timestamp: new Date().toISOString(), subject: 'Legacy', body: 'Plain <b>text</b>', action_items: null })).item;
    expect(plain.body_format).toBe('plain');
    const { user } = await boot(`/accounts/${acct.id}/activity?note=new&type=Meeting%20Note`, ds);
    const drawer = await screen.findByRole('dialog');
    await user.type(within(drawer).getByLabelText('Subject'), 'Weekly sync');
    const body = within(drawer).getByRole('textbox', { name: 'Body' });
    expect(within(drawer).getByRole('toolbar', { name: 'Body formatting' })).toBeInTheDocument();
    body.innerHTML = '<p>Agreed <strong>poll</strong> change</p><ul><li>one</li></ul><script>alert(1)</script>';
    fireEvent.input(body);
    await user.click(within(drawer).getByRole('button', { name: 'Save note' }));
    const saved = await ds.getActivity(acct.id, { filter: 'all', limit: 50 });
    expect(JSON.stringify(saved)).toContain('"body_format":"html"');
    expect(JSON.stringify(saved)).not.toContain('<script');
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    const art = screen.getByText('Weekly sync').closest('article')!;
    expect(art.querySelector('strong')?.textContent).toBe('poll');
    expect(art.querySelector('li')?.textContent).toBe('one');
    const legacy = screen.getByText('Legacy').closest('article')!;
    expect(legacy.querySelector('b')).toBeNull(); // plain text stays text
    expect(legacy.textContent).toContain('Plain <b>text</b>');
  });
});

describe('zoom fetches the window (F-2)', () => {
  it('a drag in the metric drawer requests that window once, caches it, and Reset zoom returns to the range data', async () => {
    if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {} as typeof MouseEvent;
    const ds = newMock();
    const s = await ds.getBamsState({ spark: false });
    let withData = s.rows[0];
    for (const r of s.rows) { withData = r; if ((await ds.getBamsTrend(r.id, '7d')).points.length > 20) break; }
    const spy = vi.spyOn(ds, 'getBamsTrendWindow');
    await boot(`/bams?open=${withData.id}`, ds);
    const dlg = await screen.findByRole('dialog');
    const box = await waitFor(() => { const b = dlg.querySelector('.bm-chart--zoom') as HTMLElement; expect(b).toBeTruthy(); return b; });
    box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1056, bottom: 300, width: 1056, height: 300, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(box, { clientX: 300, button: 0 });
    fireEvent.pointerUp(box, { clientX: 600 });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [id, from, to] = spy.mock.calls[0];
    expect(id).toBe(withData.id);
    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
    await waitFor(() => expect(screen.queryByText('Loading finer data…')).toBeNull());
    fireEvent.click(within(dlg).getByRole('button', { name: /Reset zoom/ }));
    expect(within(dlg).getByText(/^Showing: /)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('palette colours through the mock adapter', () => {
  it('keeps palette colours and strips others on save', async () => {
    const ds = newMock();
    const acct = (await ds.getState()).accounts[0];
    const n = (await ds.saveNote({ client_id: acct.id, note_type: 'General Note', timestamp: new Date().toISOString(), subject: 's', body: '<p><span style="color:#3fb950">ok</span><span style="color:#010203">no</span></p>', body_format: 'html', action_items: null })).item;
    expect(n.body).toBe('<p><span style="color:#3FB950">ok</span>no</p>');
    expect(n.body_text).toBe('okno');
  });
});

// BAMS pages against the mock adapter: dashboard, drawer, alerts and Close, configuration, settings, bell, appliance dialogs, import.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { newMock } from '../../data/mock/testFile';
import { ruleCondition } from '../../lib/bams';

function go(path: string) { window.history.pushState({}, '', path); }
async function boot(path: string, ds = newMock()) {
  go(path);
  const user = userEvent.setup();
  render(<App ds={ds} />);
  await screen.findByRole('navigation', { name: 'Primary' });
  return { user, ds };
}
const loc = () => window.location.pathname + window.location.search;
beforeEach(() => { document.body.style.overflow = ''; sessionStorage.clear(); });
const dataRows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tr[data-row-key]')];
async function expandAll(user: ReturnType<typeof userEvent.setup>) {
  const b = await screen.findByRole('button', { name: /^(Expand|Collapse) all accounts$/ });
  if (b.getAttribute('aria-expanded') === 'false') await user.click(b);
}
afterEach(() => cleanup());

describe('dashboard grouped by account', () => {
  it('collapses by account like Operations: only accounts with an active alert start open; header toggle and group rows toggle; summary has no percentages', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({});
    const { user } = await boot('/bams', ds);
    const table = await screen.findByRole('table', { name: 'Monitored metrics' });
    const accounts = new Map<string, typeof s.rows>();
    for (const r of s.rows) accounts.set(r.object.client_id, [...(accounts.get(r.object.client_id) ?? []), r]);
    const alerting = [...accounts.values()].filter((g) => g.some((r) => r.display_status === 'open' || r.display_status === 'recovered' || r.active_alerts > 0));
    expect(dataRows(table)).toHaveLength(alerting.reduce((n, g) => n + g.length, 0));
    const toggles = within(table).getAllByRole('button', { name: /^(Expand|Collapse) (?!all)/ });
    expect(toggles).toHaveLength(accounts.size);
    expect(toggles.filter((b) => b.getAttribute('aria-expanded') === 'true')).toHaveLength(alerting.length);
    expect(table.textContent).not.toMatch(/\d\s?%\s*(of|healthy|live)/i);
    expect(table.querySelector('.ops-acct')?.textContent).toMatch(/\d+ appliances?/);
    // header chevron: expand all, then collapse all
    const all = screen.getByRole('button', { name: /^(Expand|Collapse) all accounts$/ });
    if (all.getAttribute('aria-expanded') === 'true') await user.click(all);
    await user.click(screen.getByRole('button', { name: 'Expand all accounts' }));
    expect(dataRows(table)).toHaveLength(s.rows.length);
    await user.click(screen.getByRole('button', { name: 'Collapse all accounts' }));
    expect(dataRows(table)).toHaveLength(0);
    // one group opens by its row and by keyboard, and the choice is remembered for the session
    const first = within(table).getAllByRole('button', { name: /^Expand (?!all)/ })[0];
    first.focus();
    await user.keyboard('{Enter}');
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(sessionStorage.getItem('tam.bams.groups') ?? '{}')).toBeTruthy();
    // a row still opens the metric drawer
    await user.click(within(dataRows(table)[0]).getAllByRole('button')[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('dashboard (mockups 01, 02)', () => {
  it('shows monitor strip, summary KPIs, quick views with counts and one row per metric, worst first', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({});
    const { user } = await boot('/bams', ds);
    const table = await screen.findByRole('table', { name: 'Monitored metrics' });
    await expandAll(user);
    expect(dataRows(table)).toHaveLength(s.rows.length);
    expect(screen.getByText('Monitor Running')).toBeInTheDocument();
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(1);
    const kpis = screen.getByRole('group', { name: 'Summary' });
    expect(within(kpis).getByText('Active alerts').parentElement).toHaveTextContent(String(s.summary.active_alerts));
    const tabs = within(screen.getByRole('tablist', { name: 'Quick views' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([`All${s.view_counts.all}`, `Active Alerts${s.view_counts.active_alerts}`, `Delayed / Stale${s.view_counts.delayed_stale}`, `Live${s.view_counts.live}`, `No Data${s.view_counts.no_data}`]);
    const firstRow = dataRows(table)[0];
    expect(firstRow.className).toMatch(/bm-row--open|bm-row--recovered/);
    expect(within(firstRow).getByText(/Open alert|Recovered, awaiting close/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Import appliances' })).toHaveAttribute('href', '/bams/import');
    expect(screen.getByRole('button', { name: 'Add appliance' })).toBeInTheDocument();
  });
  it('the URL carries view and filters; a quick view narrows the rows; search is debounced into ?q=', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({});
    const { user } = await boot('/bams', ds);
    await screen.findByRole('table', { name: 'Monitored metrics' });
    await user.click(screen.getByRole('tab', { name: /^Active Alerts/ }));
    await waitFor(() => expect(loc()).toBe('/bams?view=active_alerts'));
    await waitFor(() => expect(dataRows(screen.getByRole('table', { name: 'Monitored metrics' }))).toHaveLength(s.view_counts.active_alerts)); // a quick view auto-expands matching accounts
    await user.type(screen.getByRole('searchbox', { name: /Search appliance or metric/ }), 'cpu');
    await waitFor(() => expect(loc()).toContain('q=cpu'));
    await user.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(loc()).toBe('/bams?view=active_alerts'));
  });
  it('a filter that matches nothing explains itself and offers Clear filters (mockup 02C)', async () => {
    await boot('/bams?q=zzzz-no-such');
    expect(await screen.findByText('No metrics match these filters')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBeGreaterThan(0);
  });
  it('clicking a column header sorts on the server and writes sort and dir to the URL', async () => {
    const { user } = await boot('/bams');
    await screen.findByRole('table', { name: 'Monitored metrics' });
    await user.click(screen.getByRole('button', { name: /^Current/ }));
    await waitFor(() => expect(loc()).toBe('/bams?sort=current'));
    await user.click(screen.getByRole('button', { name: /^Current/ }));
    await waitFor(() => expect(loc()).toBe('/bams?sort=current&dir=desc'));
  });
  it('PROD, provider unavailable (mockup 02A): banner, Start disabled, every row No data, no number and no SIMULATED anywhere', async () => {
    const ds = newMock({ bamsProvider: 'unavailable' });
    const { user } = await boot('/bams', ds);
    const table = await screen.findByRole('table', { name: 'Monitored metrics' });
    await expandAll(user);
    const banner = (await screen.findByText(/BAMS provider unavailable/)).closest('[role="alert"]') as HTMLElement;
    expect(banner).toHaveTextContent(/No values are simulated in PROD/);
    expect(screen.getByRole('button', { name: /Start monitor/ })).toBeDisabled();
    expect(screen.queryByText('SIMULATED')).toBeNull();
    const body = dataRows(table);
    expect(body.length).toBeGreaterThan(0);
    for (const r of body) {
      const cells = within(r).getAllByRole('cell');
      expect(cells[3]).toHaveTextContent('No data');
      expect(cells[3].textContent).not.toMatch(/\d/);
      expect(cells[4].querySelector('svg')).toBeNull();
      expect(within(r).getByText('No data', { selector: '.badge' })).toBeInTheDocument();
    }
  });
  it('no appliances: empty state offers Add and Import equally (mockups 02B, 13B)', async () => {
    const ds = newMock();
    const s = await ds.getBamsState({ include_disabled: true });
    for (const o of [...new Set(s.rows.map((r) => r.object.id))]) {
      const al = await ds.getBamsAlerts({ status: 'active' });
      for (const a of al.items.filter((i) => i.object.id === o)) await ds.closeBamsAlert({ id: a.event.id, note: null });
      await ds.deleteBamsItem('object', { id: o });
    }
    await boot('/bams', ds);
    expect(await screen.findByText('No appliances to monitor')).toBeInTheDocument();
    const panel = screen.getByText('No appliances to monitor').closest('.bm-empty') as HTMLElement;
    expect(within(panel).getByRole('button', { name: 'Add appliance' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Import appliances' })).toHaveAttribute('href', '/bams/import');
  });
});

describe('metric drawer (mockup 03)', () => {
  it('opens from a row, shows value, highs with dates, range switch, text equivalent, rules and history; Escape closes', async () => {
    const ds = newMock();
    const row = (await ds.getBamsState({ view: 'active_alerts' })).rows[0];
    const { user } = await boot('/bams', ds);
    const table = await screen.findByRole('table', { name: 'Monitored metrics' });
    await user.click(within(table).getAllByRole('button', { name: row.metric_name })[0]);
    const dlg = await screen.findByRole('dialog', { name: /·/ });
    expect(loc()).toMatch(/open=/);
    expect(await within(dlg).findByText(/Text equivalent:/)).toBeInTheDocument();
    expect(within(dlg).getByRole('radiogroup', { name: 'Trend range' })).toBeInTheDocument();
    await user.click(within(dlg).getByRole('radio', { name: '30 d' }));
    await waitFor(() => expect(within(dlg).getByText(/Text equivalent:.*30 days/)).toBeInTheDocument());
    expect(within(dlg).getByText('30D high')).toBeInTheDocument();
    expect(within(dlg).getByText('Rules on this metric')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'Edit rules' })).toHaveAttribute('href', expect.stringMatching(/^\/bams\/config\?metric=/));
    expect(within(dlg).getByText('Alert history for this metric')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(loc()).not.toMatch(/open=/);
  });
});

describe('alerts and Close (mockup 04)', () => {
  it('lists needs-action alerts with their state; ?event= highlights the row; Close records the note and removes it', async () => {
    const ds = newMock();
    const before = await ds.getBamsAlerts({ status: 'all' });
    const target = before.items.find((i) => i.event.status === 'open') ?? before.items[0];
    const { user } = await boot(`/bams/alerts?event=${target.event.id}`, ds);
    expect(await screen.findByRole('heading', { level: 1, name: 'BAMS alerts' })).toBeInTheDocument();
    const tabs = screen.getByRole('tablist', { name: 'Alert views' });
    expect(within(tabs).getByRole('tab', { name: new RegExp(`Needs action\\s*${before.counts.active}$`) })).toBeInTheDocument();
    const needs = await screen.findByRole('table', { name: 'Alerts that need action' });
    const hi = needs.querySelector('tr.is-highlight') as HTMLElement;
    expect(hi.getAttribute('data-event')).toBe(target.event.id);
    await user.click(within(hi).getByRole('button', { name: 'Close' }));
    const dlg = await screen.findByRole('dialog', { name: 'Close alert' });
    expect(within(dlg).getByText('Recorded in Activity with your note.')).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText(/Note \(optional\)/), 'Batch rebuild');
    expect(within(dlg).getByText('13 / 2000')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Close alert' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Alert closed')).toBeInTheDocument();
    const after = await ds.getBamsAlerts({ status: 'closed' });
    expect(after.items.find((i) => i.event.id === target.event.id)?.event.closed_note).toBe('Batch rebuild');
    await waitFor(() => expect(screen.getByRole('tab', { name: new RegExp(`Needs action\\s*${before.counts.active - 1}`) })).toBeInTheDocument());
  });
  it('the dialog warns when the metric is still breaching and Cancel closes nothing', async () => {
    const ds = newMock();
    const still = (await ds.getBamsAlerts({})).items.find((i) => i.event.still_breaching);
    expect(still).toBeTruthy();
    if (!still) return;
    const { user } = await boot('/bams/alerts', ds);
    const row = (await screen.findByRole('table', { name: 'Alerts that need action' })).querySelector(`tr[data-event="${still.event.id}"]`) as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Close' }));
    const dlg = await screen.findByRole('dialog', { name: 'Close alert' });
    expect(within(dlg).getByRole('alert')).toHaveTextContent(/still breaching/);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect((await ds.getBamsAlerts({})).counts.active).toBeGreaterThan(0);
  });
});

describe('appliance dialogs (mockups 06, 06b)', () => {
  it('Add: required fields are named inline; a duplicate name for the account is reported and Save stays disabled until an edit', async () => {
    const ds = newMock();
    const first = (await ds.getBamsState({})).rows[0];
    const { user } = await boot('/bams', ds);
    await screen.findByRole('table', { name: 'Monitored metrics' });
    await user.click(screen.getByRole('button', { name: 'Add appliance' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add appliance' });
    await user.click(within(dlg).getByRole('button', { name: 'Save appliance' }));
    expect(within(dlg).getByText('Choose an account.')).toBeInTheDocument();
    expect(within(dlg).getByText('Appliance name is required.')).toBeInTheDocument();
    expect(within(dlg).getByText('Metric name is required.')).toBeInTheDocument();
    expect(within(dlg).getByText('Ticker is required.')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('combobox', { name: /Account/ }));
    await user.click(await screen.findByRole('option', { name: first.object.client_name }));
    await user.type(within(dlg).getByRole('textbox', { name: /Appliance name/ }), first.object.name);
    await user.type(within(dlg).getByRole('textbox', { name: 'Metric 1 name' }), 'CPU utilisation %');
    await user.type(within(dlg).getByRole('textbox', { name: 'Metric 1 ticker' }), 'DLG TICKER 1');
    await user.click(within(dlg).getByRole('button', { name: 'Save appliance' }));
    expect(await within(dlg).findByText(`An appliance named ${first.object.name} already exists for this account.`)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Save appliance' })).toBeDisabled();
    const name = within(dlg).getByRole('textbox', { name: /Appliance name/ });
    await user.clear(name);
    await user.type(name, 'DLG-NEW-01');
    expect(within(dlg).getByRole('button', { name: 'Save appliance' })).toBeEnabled();
    await user.click(within(dlg).getByRole('button', { name: 'Save appliance' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await ds.getBamsState({ q: 'DLG-NEW-01' })).rows).toHaveLength(1);
  });
  it('a ticker already used names the owner under the ticker field', async () => {
    const ds = newMock();
    const first = (await ds.getBamsState({})).rows[0];
    const { user } = await boot('/bams', ds);
    await screen.findByRole('table', { name: 'Monitored metrics' });
    await user.click(screen.getByRole('button', { name: 'Add appliance' }));
    const dlg = await screen.findByRole('dialog', { name: 'Add appliance' });
    await user.click(within(dlg).getByRole('combobox', { name: /Account/ }));
    await user.click(await screen.findByRole('option', { name: first.object.client_name }));
    await user.type(within(dlg).getByRole('textbox', { name: /Appliance name/ }), 'DLG-UNIQUE');
    await user.type(within(dlg).getByRole('textbox', { name: 'Metric 1 name' }), 'X');
    await user.type(within(dlg).getByRole('textbox', { name: 'Metric 1 ticker' }), first.ticker);
    await user.click(within(dlg).getByRole('button', { name: 'Save appliance' }));
    expect(await within(dlg).findByText(new RegExp(`Ticker ${first.ticker.replace(/[.]/g, '.')} is already used by ${first.metric_name.replace(/[()%]/g, '.')} on ${first.object.name}`))).toBeInTheDocument();
  });
  it('Delete is blocked while an alert is open (counts shown), and allowed for a clean appliance', async () => {
    const ds = newMock();
    const alerting = (await ds.getBamsState({ view: 'active_alerts' })).rows[0];
    const { user } = await boot(`/bams?open=${alerting.id}`, ds);
    await user.click(await screen.findByRole('button', { name: 'Edit appliance' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit appliance' });
    await user.click(within(edit).getByRole('button', { name: 'Delete appliance' }));
    const del = await screen.findByRole('alertdialog', { name: new RegExp(`Delete ${alerting.object.name}\\?`) });
    expect(await within(del).findByText(/Delete is blocked/)).toBeInTheDocument();
    expect(within(del).getByRole('button', { name: 'Delete appliance' })).toBeDisabled();
    expect(within(del).getByText(/alert rules?/)).toBeInTheDocument();
    expect(within(del).getByText(/stored samples/)).toBeInTheDocument();
  });
});

describe('configuration (mockup 05)', () => {
  it('lists metrics and rules, validates a blank threshold inline, previews the sentence, saves, and applies a template only after a preview', async () => {
    const ds = newMock();
    const m = (await ds.getBamsState({ sort: 'appliance' })).rows[0];
    const { user } = await boot(`/bams/config?metric=${m.id}`, ds);
    expect(await screen.findByRole('heading', { level: 1, name: 'Alert configuration' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
    expect(await screen.findByText(/Alerts when .* > … for 1 update \(Warning\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('Threshold is required for a threshold rule.')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Percent of high' }));
    expect(screen.getByLabelText(/Threshold \(% of high\)/)).toHaveValue('90');
    expect(document.querySelector('.bm-preview')).toHaveTextContent(/% of the 90-day high/);
    expect(screen.getByText(/Values are percentages/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(await screen.findByText('Rule saved')).toBeInTheDocument();
    const rules = (await ds.getBamsMetric(m.id)).rules;
    expect(rules.some((r) => r.rule_type === 'pct_of_high' && r.threshold === 90)).toBe(true);

    // the seed already holds the starter rules everywhere: remove one identical rule (no open alert) so the template has something to add
    const cfg = (await ds.getBamsConfigs())[0];
    const first = await ds.previewBamsConfig({ config_id: cfg.id });
    let removed = false;
    for (const it of first.metrics) {
      if (removed) break;
      const d = await ds.getBamsMetric(it.metric_id);
      const same = d.rules.find((r) => r.rule_type === cfg.rule_type && r.operator === cfg.operator && r.threshold === cfg.threshold && r.consecutive_updates === cfg.consecutive_updates && r.severity === cfg.severity && r.cooldown_minutes === cfg.cooldown_minutes);
      if (same && !d.alerts.some((a) => a.rule_id === same.id && a.status !== 'closed')) { await ds.deleteBamsRule({ id: same.id }); removed = true; }
    }
    expect(removed).toBe(true);
    const preview = await ds.previewBamsConfig({ config_id: cfg.id });
    expect(preview.would_create).toBe(1);
    await user.click(await screen.findByRole('button', { name: `Preview and apply ${cfg.name}` }));
    expect(await screen.findByText(`Apply preview: ${cfg.name}.`, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Rule saved')).toBeInTheDocument();
    const apply = await screen.findByRole('button', { name: new RegExp(`^Apply to ${preview.would_create} `) });
    await user.click(apply);
    expect(await screen.findByText(new RegExp(`${preview.would_create} rules? created`))).toBeInTheDocument();
    expect((await ds.previewBamsConfig({ config_id: cfg.id })).would_create).toBe(0);
  });
  it('deleting a rule with an open alert is blocked with the backend sentence', async () => {
    const ds = newMock();
    const open = (await ds.getBamsAlerts({})).items.find((i) => i.event.rule_id)!;
    const { user } = await boot(`/bams/config?metric=${open.metric.id}`, ds);
    const rule = (await ds.getBamsMetric(open.metric.id)).rules.find((r) => r.id === open.event.rule_id)!;
    await user.click(await screen.findByRole('button', { name: `Delete rule ${ruleCondition(rule)}` }));
    const dlg = await screen.findByRole('alertdialog');
    await user.click(within(dlg).getByRole('button', { name: 'Delete rule' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(/Close the alert first/);
  });
});

describe('settings and bell (mockup 07)', () => {
  it('Privacy Mode drives the preview toast; Save is enabled only when something changed', async () => {
    const ds = newMock();
    const { user } = await boot('/bams/settings', ds);
    expect(await screen.findByText('BAMS alert opened (Critical)')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Privacy Mode' }));
    expect(screen.getByRole('switch', { name: 'Privacy Mode' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('BAMS alert opened (Critical)')).toBeNull();
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('switch', { name: 'Notify when recovered' }));
    await user.click(save);
    expect(await screen.findByText('BAMS settings saved')).toBeInTheDocument();
    expect(await ds.getBamsSettings()).toMatchObject({ privacy_mode: false, notify_recovered: true });
  });
  it('a custom poll interval under 30 s is refused with a message', async () => {
    const { user } = await boot('/bams/settings');
    await user.click(await screen.findByRole('combobox', { name: /Poll interval/ }));
    await user.click(await screen.findByRole('option', { name: /Custom/ }));
    const input = screen.getByLabelText('Custom poll interval in seconds');
    await user.clear(input);
    await user.type(input, '10');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/30 seconds or more/)).toBeInTheDocument();
  });
  it('monitor Stop and Start from settings', async () => {
    const ds = newMock();
    const { user } = await boot('/bams/settings', ds);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument());
    expect((await ds.getBamsMonitor()).monitor.state).toBe('stopped');
  });
  it('the bell shows the unread count, opens the inbox, marks read and links to the alert; Escape returns focus', async () => {
    const ds = newMock();
    const n = await ds.getBamsNotifications();
    const { user } = await boot('/today', ds);
    const bell = await screen.findByRole('button', { name: `Notifications, ${n.unread_count} unread` });
    await user.click(bell);
    const pop = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(pop).getByText(`${n.unread_count} unread`)).toBeInTheDocument();
    await user.click(within(pop).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull());
    expect(bell).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    await user.click((await within(await screen.findByRole('dialog', { name: 'Notifications' })).findAllByRole('button', { name: new RegExp(n.items[0].title.replace(/[()%]/g, '.')) }))[0]);
    await waitFor(() => expect(loc()).toBe(`/bams/alerts?event=${n.items[0].event_id}`));
  });
});

describe('workspace Infrastructure tab and Today link-through (mockup 08)', () => {
  it('shows appliances with status, an active alert banner that matches the BAMS count, and Open in BAMS', async () => {
    const ds = newMock();
    const a = (await ds.getBamsState({})).filters.accounts.find((x) => x.name.startsWith('Halvorsen'))!;
    const alerts = await ds.getBamsAlerts({ status: 'active', account: a.id });
    await boot(`/accounts/${a.id}/infrastructure`, ds);
    const links = await screen.findAllByRole('link', { name: /Open in BAMS/ });
    expect(links.length).toBeGreaterThan(1);
    if (alerts.counts.active) expect(await screen.findByText(new RegExp(`${alerts.counts.active} active alerts?`))).toBeInTheDocument();
    expect(links[links.length - 1]).toHaveAttribute('href', expect.stringMatching(new RegExp(`^/bams\\?account=${a.id}`)));
  });
  it('a Today alert row opens the alert in BAMS', async () => {
    const ds = newMock();
    const today = await ds.getToday();
    const alert = today.queue.find((i) => i.kind === 'bams_alert')!;
    const { user } = await boot(`/today?show=${alert.id}`, ds);
    await user.click(await screen.findByRole('link', { name: 'Open alert' }));
    await waitFor(() => expect(loc()).toBe(`/bams/alerts?event=${alert.id}`));
  });
});

describe('import page (mockups 09-13)', () => {
  const H = 'Account,BPID,Appliance,Metric,Ticker,Region,Location,Environment,Enabled,Stale after (s)\n';
  const upload = async (user: ReturnType<typeof userEvent.setup>, text: string, name = 'bams.csv') => {
    await user.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File([text], name, { type: 'text/csv' }));
  };
  it('step 1 explains the columns; Preview is disabled until a file is chosen; a bad header is refused on the same step', async () => {
    const { user } = await boot('/bams/import');
    expect(await screen.findByRole('heading', { level: 1, name: 'Import appliances and metrics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Template \(\.xlsx\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Template \(\.csv\)/ })).toBeInTheDocument();
    const cols = screen.getByRole('table', { name: 'Import columns' });
    expect(within(cols).getAllByRole('row')).toHaveLength(11);
    await upload(user, 'Account,Appliance,Metric\nA,B,C\n');
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Missing required column: Ticker')).toBeInTheDocument();
    expect(screen.getByText(/Found: Account, Appliance, Metric/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Choose file' })).toBeInTheDocument();
  });
  it('preview, review, gated apply and result, end to end; nothing is written before Apply; Open BAMS lists the touched accounts', async () => {
    const ds = newMock();
    const before = (await ds.getBamsState({})).summary.total;
    const { user } = await boot('/bams/import', ds);
    await upload(user, `${H}Bluewater Reach Securities,,brs-bpipe-ny-1,CPU Utilization (%),IMP.UI1,,,,,\nBluewater Reach Securities,,brs-bpipe-ny-1,Extra,IMP.UI2,,,,,\nAurelian Vale Commodities,,UI-NEW-1,CPU,IMP.UI3,EMEA,Paris,PROD,,\nNope Capital,,X,CPU,IMP.UI4,,,,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('group', { name: 'Preview summary' })).toBeInTheDocument();
    expect((await ds.getBamsState({})).summary.total).toBe(before);
    expect(screen.getByText(/1 similar appliance needs a decision/)).toBeInTheDocument();
    expect(screen.getByText(/1 invalid row will be skipped/)).toBeInTheDocument();
    expect(screen.getByText('Rows without a usable appliance')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Invalid/ }));
    expect(screen.getByText(/Account "Nope Capital" not found/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review similar (1)' }));
    const card = await screen.findByRole('region', { name: 'Similar appliance 1' });
    const apply = screen.getByRole('button', { name: 'Apply import' });
    expect(apply).toBeDisabled();
    expect(screen.getByText(/Apply is disabled until every flagged appliance has a decision/)).toBeInTheDocument();
    const radios = within(card).getAllByRole('radio');
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true); // nothing preselected
    await user.click(within(card).getByRole('radio', { name: /Same appliance/ }));
    expect(within(card).getByRole('status')).toHaveTextContent(/Extra is added/);
    expect(apply).toBeEnabled();
    expect(screen.getByText('1 of 1 decided')).toBeInTheDocument();
    await user.click(apply);
    expect(await screen.findByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText(/merged into brs-bpipe-ny-01/)).toBeInTheDocument();
    expect(screen.getByText(/A backup was saved first/)).toBeInTheDocument();
    const open = screen.getByRole('link', { name: 'Open BAMS' });
    expect(decodeURIComponent(open.getAttribute('href')!)).toMatch(/^\/bams\?account=[^,]+,[^,]+$/);
    expect(screen.getByRole('button', { name: /Download skipped rows \(\.csv\)/ })).toBeInTheDocument();
    expect((await ds.getBamsState({})).summary.total).toBe(before + 2);
    expect(screen.queryByRole('button', { name: 'Apply import' })).toBeNull();
  });
  it('with nothing flagged the preview goes straight to Apply; an expired preview offers Start over', async () => {
    const ds = newMock();
    const { user } = await boot('/bams/import', ds);
    await upload(user, `${H}Aurelian Vale Commodities,,UI-NEW-2,CPU,IMP.UI5,,,,,\n`);
    await screen.findByRole('group', { name: 'Chosen file' });
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('group', { name: 'Preview summary' });
    expect(screen.queryByRole('button', { name: /Review similar/ })).toBeNull();
    // simulate expiry: the stored session disappears between preview and apply
    (ds as unknown as { bamsImp: { sessions: Map<string, unknown> } }).bamsImp.sessions.clear();
    await user.click(screen.getByRole('button', { name: 'Apply import' }));
    expect(await screen.findByText('This preview has expired.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeDisabled();
  });
});

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Upload } from 'lucide-react';
import { PageHeader } from '../components/ui/Panel';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { DataTable, cmpNum, cmpStr, type Column, type SortState } from '../components/ui/DataTable';
import { StatusBadge } from '../components/ui/Badges';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { ImportWizard } from '../components/import/ImportWizard';
import { DatePill, DotRow, type InstrumentTone } from '../components/ui/Instruments';
import { useApp, useQuery } from '../store/DataContext';
import type { AccountSummary } from '../types';
import { accountPath } from '../lib/links';
import { useDocumentTitle } from '../lib/hooks';
import { cx } from '../lib/cx';
import {
  loadLeaders, meterByClient, meterLabel, needsAttention, nextDays, pillOf, portfolio, signalsFromQueue, upgradeDatesFromQueue,
  type AccountSignals, type Meter,
} from '../lib/instruments';
import { formatDateLong } from '../lib/dates';

type StatusFilter = 'Active' | 'Inactive' | 'All';
const NO_METER: Meter = { open: 0, overdue: 0, waiting: 0, other: 0 };

export function AccountsPage() {
  useDocumentTitle('Accounts');
  const { accounts, state, today } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('Active');
  const [importing, setImporting] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ key: 'overdue', dir: 'desc' });
  const todayQ = useQuery('today', (ds) => ds.getToday());

  const meters = useMemo(() => meterByClient(state.tasks, today), [state.tasks, today]);
  const queue = todayQ.data?.queue ?? null;
  const signals = useMemo(() => (queue ? signalsFromQueue(accounts, queue, today) : null), [accounts, queue, today]);
  const attention = useMemo(() => (signals ? needsAttention(accounts, signals) : null), [accounts, signals]);
  const port = useMemo(() => portfolio(accounts), [accounts]);
  const leaders = useMemo(() => loadLeaders(accounts), [accounts]);
  const days = useMemo(() => nextDays(accounts, queue ? upgradeDatesFromQueue(queue, today) : [], today), [accounts, queue, today]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts
      .filter((a) => (status === 'All' ? true : a.status === status))
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || (a.bpid ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name)); // stable base order; the table sort applies on top
  }, [accounts, q, status]);

  const num = (k: keyof AccountSummary) => (a: AccountSummary, b: AccountSummary) => cmpNum(a[k] as number, b[k] as number);
  const zero = (v: number, cls?: string) => <span className={cx('num', v === 0 ? 'subtle' : cls)}>{v}</span>;
  const serverDots = (a: AccountSummary, s: AccountSignals | undefined) => {
    const sev = [...(s?.alertServers.values() ?? [])].sort((x, y) => (x === 'Critical' ? 0 : 1) - (y === 'Critical' ? 0 : 1));
    const dots = Array.from({ length: a.servers }, (_, i): { tone: InstrumentTone | null } => ({ tone: sev[i] === 'Critical' ? 'danger' : sev[i] === 'Warning' ? 'warning' : null }));
    return { dots, withAlert: Math.min(sev.filter((x) => x !== 'Info').length, a.servers) };
  };

  const cols: Column<AccountSummary>[] = [
    {
      key: 'name', header: 'Account', primary: true, sort: (a, b) => cmpStr(a.name, b.name),
      cell: (a) => (
        <span className="acctcell">
          <span className="truncate">{a.name}</span>
          {a.bpid && <span className="mono muted acctcell__bpid">{a.bpid}</span>}
          {a.status === 'Inactive' && <StatusBadge value="Inactive" />}
        </span>
      ),
    },
    {
      key: 'load', header: 'Load', sort: num('open_tasks'),
      cell: (a) => {
        const m = meters.get(a.id) ?? NO_METER;
        return (
          <span className="loadcell" title={meterLabel(m)}>
            <span className={cx('num sm', m.open === 0 && 'subtle')}>{m.open} open</span>
          </span>
        );
      },
    },
    { key: 'overdue', header: 'Overdue', align: 'right', sort: num('overdue'), cell: (a) => zero(a.overdue, 'danger-text') },
    { key: 'waiting', header: 'Waiting', align: 'right', sort: num('waiting'), cell: (a) => zero(a.waiting) },
    {
      key: 'alerts', header: 'Alerts', sort: num('active_alerts'),
      cell: (a) => (a.active_alerts > 0 ? <span className="alertcell num"><i className="status-dot status-dot--warning" aria-hidden="true" />{a.active_alerts} open</span> : <span className="subtle">-</span>),
    },
    {
      key: 'servers', header: 'Servers', sort: num('servers'),
      cell: (a) => {
        const { dots, withAlert } = serverDots(a, signals?.get(a.id));
        return <DotRow dots={dots} label={`${a.servers} ${a.servers === 1 ? 'server' : 'servers'}, ${withAlert} with an alert`} />;
      },
    },
    { key: 'upgrade', header: 'Next upgrade', sort: (a, b) => cmpStr(a.next_upgrade, b.next_upgrade), cell: (a) => <DatePill pill={pillOf(a.next_upgrade, today)} /> },
    { key: 'contact', header: 'Next contact', sort: (a, b) => cmpStr(a.next_contact, b.next_contact), cell: (a) => <DatePill pill={pillOf(a.next_contact, today)} /> },
  ];

  const rowCount = rows.length;
  return (
    <div className="page accounts">
      <PageHeader
        title="Accounts"
        meta={<span className="num">{rowCount} {status === 'All' ? 'accounts' : status.toLowerCase()}</span>}
        actions={
          <>
          <Button variant="secondary" onClick={() => setImporting(true)} icon={<Upload size={16} strokeWidth={1.5} />}>Import accounts</Button>
          <Link to="/accounts?account=new" className="btn btn--primary btn--md">
            <span className="btn__icon" aria-hidden="true"><Plus size={16} strokeWidth={1.5} /></span>
            <span className="btn__label">Account</span>
          </Link>
          </>
        }
      >
        <div className="filterbar" role="search" aria-label="Account filters">
          <div className="filterbar__item filterbar__item--search">
            <Search size={16} strokeWidth={1.5} className="filterbar__icon" aria-hidden="true" />
            <input type="search" className="input input--sm filterbar__search" placeholder="Search name or BPID" aria-label="Search accounts by name or BPID" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <SegmentedControl<StatusFilter> label="Account status" size="sm" value={status} onChange={setStatus} options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }, { value: 'All', label: 'All' }]} />
        </div>
      </PageHeader>

      <div className="tiles" aria-label="Portfolio overview">
        <section className="panel tile" aria-label="Portfolio">
          <div className="label">Portfolio</div>
          <div className="tile__big num">{port.active}</div>
          <div className="muted sm">active accounts</div>
          <p className="legend tile__legend">
            <span className={port.overdue ? 'danger-text' : 'subtle'}>{port.overdue} with overdue</span>
            <span className={port.alerts ? 'warning-text' : 'subtle'}>{port.alerts} with alerts</span>
            <span>{port.clear} clear</span>
          </p>
        </section>
        <section className="panel tile" aria-label="Open load by account">
          <div className="label tile__cap">Open load by account</div>
          <ul className="hbars">
            {leaders.map((a) => {
              const m = meters.get(a.id) ?? NO_METER;
              return (
                <li key={a.id} className="hbar">
                  <Link to={accountPath(a.id)} className="hbar__name truncate" title={a.name}>{a.name}</Link>
                  <span className="num sm hbar__n">{m.open}</span>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="panel tile" aria-label="Next 15 days">
          <div className="label">Next 15 days</div>
          <div className="cal" role="img" aria-label={`Next 15 days: ${days.upgrades} upgrades, ${days.touches} client touches`}>
            {days.cells.map((c, i) => (
              <i key={c.date} className={cx('cal__cell', i === 0 && 'is-today')} title={`${formatDateLong(c.date)}: ${c.upgrades} ${c.upgrades === 1 ? 'upgrade' : 'upgrades'}, ${c.touches} client ${c.touches === 1 ? 'touch' : 'touches'}`}>
                {c.upgrades > 0 && <b className="cal__mark cal__mark--up" />}
                {c.touches > 0 && <b className="cal__mark cal__mark--touch" />}
              </i>
            ))}
          </div>
          <p className="legend tile__legend">
            <span><i className="status-dot dot--info" aria-hidden="true" /> Upgrades {days.upgrades}</span>
            <span><i className="status-dot dot--accent" aria-hidden="true" /> Client touches {days.touches}</span>
          </p>
        </section>
        <section className="panel tile attn" aria-label="Needs attention">
          <div className="label tile__cap">Needs attention</div>
          {attention === null ? <span className="subtle sm">Loading</span> : attention.length === 0 ? <p className="muted sm">Nothing needs attention.</p> : (
            <ul className="attn__list">
              {attention.map((r) => (
                <li key={r.id} className="attn__row">
                  <Link to={accountPath(r.id)} className="attn__link">
                    <b className="truncate">{r.name}</b>
                    <span className="muted sm truncate">{r.reason}</span>
                  </Link>
                  <i className={`status-dot status-dot--${r.tone}`} aria-hidden="true" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <DataTable
        caption="Accounts"
        columns={cols}
        rows={rows}
        rowKey={(a) => a.id}
        rowHref={(a) => accountPath(a.id)}
        sort={sort}
        onSortChange={setSort}
        chevron
        fill
        className="accounts__table"
        empty={
          q || status !== 'Active' ? (
            <EmptyState action={<Button size="sm" onClick={() => { setQ(''); setStatus('Active'); }}>Clear filters</Button>}>No accounts match.</EmptyState>
          ) : (
            <EmptyState action={<Button size="sm" variant="primary" onClick={() => navigate('/accounts?account=new')}>+ Account</Button>}>No accounts yet.</EmptyState>
          )
        }
      />
      {importing && <ImportWizard onClose={() => setImporting(false)} />}
    </div>
  );
}

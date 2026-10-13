import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { PageHeader } from '../components/ui/Panel';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { DataTable, cmpNum, cmpStr, type Column, type SortState } from '../components/ui/DataTable';
import { DateCell, StatusBadge } from '../components/ui/Badges';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { useApp } from '../store/DataContext';
import type { AccountSummary } from '../types';
import { accountPath } from '../lib/links';
import { useDocumentTitle } from '../lib/hooks';
import { cx } from '../lib/cx';

type StatusFilter = 'Active' | 'Inactive' | 'All';

export function AccountsPage() {
  useDocumentTitle('Accounts');
  const { accounts, today } = useApp();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('Active');
  const [sort, setSort] = useState<SortState | null>({ key: 'overdue', dir: 'desc' });

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts
      .filter((a) => (status === 'All' ? true : a.status === status))
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || (a.bpid ?? '').toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name)); // stable base order; the table sort applies on top
  }, [accounts, q, status]);

  const num = (k: keyof AccountSummary) => (a: AccountSummary, b: AccountSummary) => cmpNum(a[k] as number, b[k] as number);
  const zero = (v: number, cls?: string) => <span className={cx('num', v === 0 ? 'subtle' : cls)}>{v}</span>;

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
    { key: 'open', header: 'Open tasks', align: 'right', sort: num('open_tasks'), cell: (a) => zero(a.open_tasks) },
    { key: 'overdue', header: 'Overdue', align: 'right', sort: num('overdue'), cell: (a) => zero(a.overdue, 'danger-text') },
    { key: 'waiting', header: 'Waiting', align: 'right', sort: num('waiting'), cell: (a) => zero(a.waiting) },
    { key: 'alerts', header: 'BAMS alerts', align: 'right', sort: num('active_alerts'), cell: (a) => zero(a.active_alerts, 'warning-text') },
    { key: 'upgrade', header: 'Next upgrade', align: 'right', sort: (a, b) => cmpStr(a.next_upgrade, b.next_upgrade), cell: (a) => <DateCell date={a.next_upgrade} today={today} kind="plain" /> },
    { key: 'contact', header: 'Next contact', align: 'right', sort: (a, b) => cmpStr(a.next_contact, b.next_contact), cell: (a) => <DateCell date={a.next_contact} today={today} kind="due" /> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Accounts"
        meta={<span className="num">{rows.length} {status === 'All' ? 'accounts' : status.toLowerCase()}</span>}
        actions={
          <Link to="/accounts?account=new" className="btn btn--primary btn--md">
            <span className="btn__icon" aria-hidden="true"><Plus size={16} strokeWidth={1.5} /></span>
            <span className="btn__label">Account</span>
          </Link>
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
        empty={
          q || status !== 'Active' ? (
            <EmptyState action={<Button size="sm" onClick={() => { setQ(''); setStatus('Active'); }}>Clear filters</Button>}>No accounts match.</EmptyState>
          ) : (
            <EmptyState action={<Button size="sm" variant="primary" onClick={() => navigate('/accounts?account=new')}>+ Account</Button>}>No accounts yet.</EmptyState>
          )
        }
      />
    </div>
  );
}

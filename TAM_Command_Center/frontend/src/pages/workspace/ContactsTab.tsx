import { Link, useLocation } from 'react-router-dom';
import { Plus, Star } from 'lucide-react';
import { DataTable, cmpStr, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { useApp, useData } from '../../store/DataContext';
import type { AccountSummary, Contact } from '../../types';
import { cx } from '../../lib/cx';

function drawerLink(pathname: string, search: string, id: string) {
  const p = new URLSearchParams(search);
  p.set('contact', id);
  return `${pathname}?${p.toString()}`;
}

export function ContactsTab({ account }: { account: AccountSummary }) {
  const { state } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const loc = useLocation();
  const rows = state.contacts.filter((c) => c.client_id === account.id);

  const toggle = async (c: Contact) => {
    try {
      const r = await ds.saveContact({
        id: c.id, client_id: c.client_id, name: c.name, role: c.role, team: c.team, email: c.email, is_primary: !c.is_primary, expected_row_version: c.row_version,
      });
      bump();
      toast.push({ kind: 'success', message: r.message ?? (c.is_primary ? `${c.name} is no longer primary` : `${c.name} is now primary`) });
    } catch (e) {
      toast.push({ kind: 'error', message: 'Could not change the primary contact.', detail: e instanceof Error ? e.message : undefined });
    }
  };

  const cols: Column<Contact>[] = [
    { key: 'name', header: 'Name', primary: true, sort: (a, b) => cmpStr(a.name, b.name), cell: (c) => c.name },
    { key: 'role', header: 'Role', sort: (a, b) => cmpStr(a.role, b.role), cell: (c) => c.role ?? <span className="subtle">-</span> },
    { key: 'team', header: 'Team', sort: (a, b) => cmpStr(a.team, b.team), cell: (c) => c.team ?? <span className="subtle">-</span> },
    { key: 'email', header: 'Email', cell: (c) => (c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="subtle">-</span>) },
    {
      key: 'primary', header: 'Primary', width: 110,
      sort: (a, b) => Number(b.is_primary) - Number(a.is_primary),
      cell: (c) => (
        <button type="button" className={cx('starbtn', c.is_primary && 'is-primary')} aria-pressed={c.is_primary} aria-label={c.is_primary ? `${c.name} is primary. Click to clear.` : `Make ${c.name} primary`} onClick={() => void toggle(c)}>
          <Star size={16} strokeWidth={1.5} fill={c.is_primary ? 'currentColor' : 'none'} aria-hidden="true" />
          <span>{c.is_primary ? 'Primary' : 'Make primary'}</span>
        </button>
      ),
    },
  ];
  const newLink = drawerLink(loc.pathname, loc.search, 'new');

  return (
    <div className="contacts">
      <div className="filterbar">
        <span className="muted num">{rows.length} contact{rows.length === 1 ? '' : 's'}{rows.some((c) => c.is_primary) ? '' : ' · no primary contact'}</span>
        <div className="filterbar__spacer" />
        <Link to={newLink} className="btn btn--primary btn--sm"><span className="btn__icon" aria-hidden="true"><Plus size={16} strokeWidth={1.5} /></span><span className="btn__label">Contact</span></Link>
      </div>
      <DataTable
        caption={`${account.name} contacts`}
        columns={cols}
        rows={rows}
        rowKey={(c) => c.id}
        rowHref={(c) => drawerLink(loc.pathname, loc.search, c.id)}
        defaultSort={{ key: 'primary', dir: 'asc' }}
        chevron
        empty={<EmptyState action={<Link className="btn btn--primary btn--sm" to={newLink}><span className="btn__label">+ Contact</span></Link>}>No contacts yet for this account.</EmptyState>}
      />
    </div>
  );
}

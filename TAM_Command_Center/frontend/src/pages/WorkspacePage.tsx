import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity, ChevronDown, ChevronLeft, History, LayoutDashboard, ListChecks, Server, Users } from 'lucide-react';
import { Tabs, type TabItem } from '../components/ui/Tabs';
import { EmptyState } from '../components/ui/Feedback';
import { useApp, useQuery } from '../store/DataContext';
import { HeaderBand } from './workspace/HeaderBand';
import { WORKSPACE_TABS, accountPath, type WorkspaceTab } from '../lib/links';
import { useDocumentTitle, useMediaQuery } from '../lib/hooks';
import { ContextRail } from './workspace/ContextRail';
import { OverviewTab } from './workspace/OverviewTab';
import { ActivityTab } from './workspace/ActivityTab';
import { InfrastructureTab } from './workspace/InfrastructureTab';
import { ContactsTab } from './workspace/ContactsTab';
import { TaskList } from '../components/tasks/TaskList';
import { cx } from '../lib/cx';

export function WorkspacePage() {
  const { clientId = '', tab } = useParams();
  const { accountById, state } = useApp();
  const navigate = useNavigate();
  const loc = useLocation();
  const account = accountById(clientId);
  const narrow = useMediaQuery('(max-width: 1099px)');
  const current = (WORKSPACE_TABS as string[]).includes(tab ?? '') ? (tab as WorkspaceTab) : null;
  const [briefOpen, setBriefOpen] = useState(current === 'overview');
  useDocumentTitle(account?.name ?? 'Account');
  const infra = useQuery(`infra:${clientId}`, (ds) => ds.getInfrastructure(clientId), { enabled: !!account });
  const todayQ = useQuery('today', (ds) => ds.getToday(), { enabled: !!account });

  // The brief starts expanded on Overview and collapsed elsewhere (narrow layout only).
  useEffect(() => { setBriefOpen(current === 'overview'); }, [current, clientId]);

  if (!account) {
    return (
      <div className="page">
        <EmptyState action={<Link to="/accounts">Back to Accounts</Link>}>This account does not exist (it may have been deleted).</EmptyState>
      </div>
    );
  }
  if (!current) return <Navigate to={accountPath(clientId, 'overview')} replace />;

  const contactCount = state.contacts.filter((c) => c.client_id === account.id).length;
  const items: TabItem[] = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={16} strokeWidth={1.5} /> },
    { id: 'tasks', label: 'Tasks', icon: <ListChecks size={16} strokeWidth={1.5} />, count: account.open_tasks },
    { id: 'activity', label: 'Activity', icon: <History size={16} strokeWidth={1.5} /> },
    { id: 'infrastructure', label: 'Infrastructure', icon: <Server size={16} strokeWidth={1.5} /> },
    { id: 'contacts', label: 'Contacts', icon: <Users size={16} strokeWidth={1.5} />, count: contactCount },
  ];
  const editLink = (() => { const p = new URLSearchParams(loc.search); p.set('account', 'edit'); return `${loc.pathname}?${p.toString()}`; })();

  return (
    <div className="page ws">
      <Link to="/accounts" className="ws__back"><ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" /> Accounts</Link>
      <HeaderBand account={account} infra={infra.data} queue={todayQ.data?.queue ?? null} editLink={editLink} />
      <Tabs items={items} value={current} onChange={(id) => navigate(accountPath(clientId, id as WorkspaceTab))} label={`${account.name} sections`} idPrefix="ws" />
      <div className="ws__grid">
        {narrow && (
          <div className="brief">
            <button type="button" className="brief__toggle" aria-expanded={briefOpen} aria-controls="brief-body" onClick={() => setBriefOpen((o) => !o)}>
              <Activity size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="label">Account brief</span>
              <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" className={cx('brief__chev', briefOpen && 'is-open')} />
            </button>
            <div id="brief-body" hidden={!briefOpen}>
              <ContextRail account={account} />
            </div>
          </div>
        )}
        <div id="ws-panel" role="tabpanel" aria-labelledby={`ws-tab-${current}`} className="ws__main">
          {current === 'overview' && <OverviewTab account={account} infra={infra} todayQ={todayQ} />}
          {current === 'tasks' && <TaskList clientId={account.id} caption={`${account.name} tasks`} />}
          {current === 'activity' && <ActivityTab account={account} />}
          {current === 'infrastructure' && <InfrastructureTab q={infra} />}
          {current === 'contacts' && <ContactsTab account={account} />}
        </div>
        {!narrow && <ContextRail account={account} />}
      </div>
    </div>
  );
}

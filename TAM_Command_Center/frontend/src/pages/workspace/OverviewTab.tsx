import { useLocation, Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Panel } from '../../components/ui/Panel';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { DateCell, PriorityLabel, StatusBadge } from '../../components/ui/Badges';
import { EmptyState, ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { Timeline } from '../../components/activity/Timeline';
import { taskDrawerLink } from '../../lib/links';
import { topOpenTasks } from '../../lib/tasks';
import { useApp, useQuery } from '../../store/DataContext';
import type { AccountSummary, Task } from '../../types';
import { accountPath } from '../../lib/links';

export function OverviewTab({ account }: { account: AccountSummary }) {
  const { state, today, settings } = useApp();
  const loc = useLocation();
  const act = useQuery(`activity:${account.id}:overview`, (ds) => ds.getActivity(account.id, { filter: 'all', limit: 10 }));
  const mine = state.tasks.filter((t) => t.client_id === account.id);
  const top = topOpenTasks(mine, today, 8);

  const cols: Column<Task>[] = [
    { key: 'task', header: 'Task', primary: true, cell: (t) => <span className="truncate" title={t.task}>{t.task}</span> },
    { key: 'priority', header: 'Priority', cell: (t) => <PriorityLabel value={t.priority} /> },
    { key: 'due', header: 'Due', align: 'right', cell: (t) => <DateCell date={t.due} today={today} /> },
    { key: 'status', header: 'Status', cell: (t) => <StatusBadge value={t.status} /> },
    { key: 'waiting', header: 'Waiting on', cell: (t) => (t.waiting ? <span className="truncate muted" title={t.waiting}>{t.waiting}</span> : <span className="subtle">-</span>) },
  ];

  return (
    <div className="overview">
      <Panel
        title="Open tasks"
        actions={<Link className="more-link" to={accountPath(account.id, 'tasks')}>View all ({account.open_tasks}) <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" /></Link>}
      >
        <DataTable
          caption={`Top open tasks for ${account.name}`}
          columns={cols}
          rows={top}
          rowKey={(t) => t.id}
          rowHref={(t) => taskDrawerLink(loc.pathname, loc.search, t.id)}
          chevron
          empty={<EmptyState action={<Link className="btn btn--primary btn--sm" to={taskDrawerLink(loc.pathname, loc.search, 'new')}><span className="btn__label">+ Task</span></Link>}>No open tasks for this account.</EmptyState>}
        />
      </Panel>
      <Panel
        title="Recent activity"
        actions={<Link className="more-link" to={accountPath(account.id, 'activity')}>View all <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" /></Link>}
        bodyClassName="panel__body--pad"
      >
        {act.loading && <SkeletonRows rows={4} label="Loading activity" />}
        {act.error ? <ErrorBanner error={act.error} onRetry={act.reload} title="Could not load activity" /> : null}
        {act.data && act.data.items.length === 0 && <EmptyState>No activity yet.</EmptyState>}
        {act.data && act.data.items.length > 0 && <Timeline entries={act.data.items} clientId={account.id} tz={settings.time_display} today={today} />}
      </Panel>
    </div>
  );
}

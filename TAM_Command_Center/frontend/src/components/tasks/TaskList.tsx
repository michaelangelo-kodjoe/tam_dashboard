import { TerminalLinkText } from '../ui/TerminalLinkText';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2, Plus, Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Select } from '../ui/Select';
import { Checkbox } from '../ui/Checkbox';
import { DataTable, cmpNum, cmpStr, type Column } from '../ui/DataTable';
import { DateCell, PriorityLabel, StatusBadge } from '../ui/Badges';
import { EmptyState, ErrorBanner } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { taskToInput } from '../../lib/tasks';
import { useApp, useData, useQuery } from '../../store/DataContext';
import { TASK_CATEGORIES, TASK_PRIORITIES, TASK_STATUSES, type Task } from '../../types';
import { accountPath, taskDrawerLink } from '../../lib/links';
import { formatDate } from '../../lib/dates';
import { DataSourceError } from '../../data/DataSource';

const PRIO: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const STAT: Record<string, number> = { 'Not Started': 0, 'In Progress': 1, Waiting: 2, Complete: 3 };
const opts = (a: readonly string[]) => a.map((v) => ({ value: v, label: v }));

/** Shared by the account Tasks tab and the global Tasks page (D-20). */
export function TaskList({ clientId, caption }: { clientId?: string; caption: string }) {
  const { state, today, accountById } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const loc = useLocation();
  const global = !clientId;

  const [status, setStatus] = useState<string>('open');
  const [priority, setPriority] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [account, setAccount] = useState<string>('all'); // global only: all | none | <id>
  const [text, setText] = useState('');
  const [archived, setArchived] = useState(false);

  const archivedQ = useQuery<Task[]>(`tasks-archived:${clientId ?? 'all'}`, (d) => d.getTasks({ client_id: clientId, archived: true }), { enabled: archived });

  const all = useMemo(() => {
    const live = state.tasks.filter((t) => (clientId ? t.client_id === clientId : true));
    return archived ? [...live, ...(archivedQ.data ?? [])] : live;
  }, [state.tasks, clientId, archived, archivedQ.data]);

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return all.filter((t) => {
      if (status === 'open' ? t.status === 'Complete' : status !== 'all' && t.status !== status) return false;
      if (priority !== 'all' && t.priority !== priority) return false;
      if (category !== 'all' && t.category !== category) return false;
      if (global && account !== 'all' && (account === 'none' ? t.client_id !== null : t.client_id !== account)) return false;
      if (q && !(t.task.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q) || (t.waiting ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [all, status, priority, category, account, text, global]);

  const [confirming, setConfirming] = useState<Task | null>(null);
  const [completing, setCompleting] = useState(false);
  const complete = async (t: Task) => {
    setCompleting(true);
    try {
      const saved = await ds.saveTask({ ...taskToInput(t), status: 'Complete' });
      setConfirming(null);
      bump();
      toast.push({
        kind: 'success', message: 'Task completed', detail: t.task,
        onAction: {
          label: 'Undo',
          run: () => {
            // reopen to the previous status; same save path as an edit, guarded by the new row_version
            void ds.saveTask({ ...taskToInput(t), status: t.status, expected_row_version: saved.item.row_version }).then(
              () => { bump(); toast.push({ kind: 'info', message: 'Task reopened', detail: t.task }); },
              (e) => toast.push({ kind: 'error', message: 'Could not undo.', detail: e instanceof Error ? e.message : undefined }),
            );
          },
        },
      });
    } catch (e) {
      setConfirming(null);
      toast.push({ kind: 'error', message: e instanceof DataSourceError && e.code === 'stale_write' ? 'This task changed elsewhere. Reload and try again.' : 'Could not complete the task.', detail: e instanceof Error ? e.message : undefined });
    } finally { setCompleting(false); }
  };

  const newLink = taskDrawerLink(loc.pathname, loc.search, 'new');
  const cols: Column<Task>[] = [
    {
      key: 'task', header: 'Task', primary: true, sort: (a, b) => cmpStr(a.task, b.task),
      cell: (t) => (
        <span className="taskcell">
          <span className="truncate" title={t.task}>{t.task}</span>
          {t.archived && <span className="tag">Archived</span>}
        </span>
      ),
    },
    ...(global
      ? [{
          key: 'account', header: 'Account', sort: (a: Task, b: Task) => cmpStr(accountById(a.client_id)?.name, accountById(b.client_id)?.name),
          cell: (t: Task) => (t.client_id ? <Link className="acct-link" to={accountPath(t.client_id)}>{accountById(t.client_id)?.name ?? 'Unknown'}</Link> : <span className="subtle">No account</span>),
        } satisfies Column<Task>]
      : []),
    { key: 'category', header: 'Category', sort: (a, b) => cmpStr(a.category, b.category), cell: (t) => <span className="muted">{t.category}</span> },
    { key: 'priority', header: 'Priority', sort: (a, b) => cmpNum(PRIO[a.priority], PRIO[b.priority]), cell: (t) => <PriorityLabel value={t.priority} /> },
    { key: 'due', header: 'Due', align: 'right', sort: (a, b) => cmpStr(a.due, b.due), cell: (t) => <DateCell date={t.due} today={today} kind={t.status === 'Complete' ? 'plain' : 'due'} /> },
    { key: 'next_update', header: 'Next update', align: 'right', sort: (a, b) => cmpStr(a.next_update, b.next_update), cell: (t) => <DateCell date={t.next_update} today={today} kind="plain" showRelative={false} /> },
    { key: 'status', header: 'Status', sort: (a, b) => cmpNum(STAT[a.status], STAT[b.status]), cell: (t) => <StatusBadge value={t.status} /> },
    { key: 'notes', header: 'Notes', className: 'col-narrow', cell: (t) => (t.notes ? <span className="truncate tasknotes" title={t.notes}><TerminalLinkText text={t.notes} /></span> : <span className="subtle">-</span>) },
    { key: 'waiting', header: 'Waiting on', className: 'col-narrow', sort: (a, b) => cmpStr(a.waiting, b.waiting), cell: (t) => (t.waiting ? <span className="truncate" title={t.waiting}>{t.waiting}</span> : <span className="subtle">-</span>) },
    { key: 'updated', header: 'Updated', align: 'right', sort: (a, b) => cmpStr(a.updated_at, b.updated_at), cell: (t) => <span className="muted num">{formatDate(t.updated_at.slice(0, 10), today)}</span> },
    {
      key: 'actions', header: 'Actions', hideHeader: true, width: 40,
      cell: (t) =>
        t.status !== 'Complete' ? (
          <span className="rowaction">
            <Button variant="icon" size="sm" aria-label={`Mark complete: ${t.task}`} title="Mark complete" onClick={() => setConfirming(t)} icon={<CheckCircle2 size={16} strokeWidth={1.5} />} />
          </span>
        ) : null,
    },
  ];

  const accountOptions = [{ value: 'all', label: 'All accounts' }, { value: 'none', label: 'No account' }, ...[...state.accounts].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name }))];
  const filtered = status !== 'open' || priority !== 'all' || category !== 'all' || account !== 'all' || text !== '';

  return (
    <div className="tasklist">
      <div className="filterbar tasklist__head">
        <span className="muted num" aria-live="polite">{rows.length} task{rows.length === 1 ? '' : 's'}{archived && archivedQ.data ? ` (${archivedQ.data.length} archived loaded)` : ''}</span>
        <div className="filterbar__spacer" />
        <Link to={newLink} className="btn btn--primary btn--sm" aria-label="New task"><span className="btn__icon" aria-hidden="true"><Plus size={16} strokeWidth={1.5} /></span><span className="btn__label">Task</span></Link>
      </div>
      <div className="filterbar" role="search" aria-label="Task filters">
        <div className="filterbar__item filterbar__item--search">
          <Search size={16} strokeWidth={1.5} className="filterbar__icon" aria-hidden="true" />
          <input type="search" className="input input--sm filterbar__search" placeholder="Search tasks, notes, waiting" aria-label="Search tasks" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select size="sm" aria-label="Status filter" value={status} onChange={(v) => setStatus(v ?? 'open')} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All statuses' }, ...opts(TASK_STATUSES)]} />
        <Select size="sm" aria-label="Priority filter" value={priority} onChange={(v) => setPriority(v ?? 'all')} options={[{ value: 'all', label: 'All priorities' }, ...opts(TASK_PRIORITIES)]} />
        <Select size="sm" aria-label="Category filter" value={category} onChange={(v) => setCategory(v ?? 'all')} options={[{ value: 'all', label: 'All categories' }, ...opts(TASK_CATEGORIES)]} />
        {global && <Select size="sm" aria-label="Account filter" value={account} onChange={(v) => setAccount(v ?? 'all')} options={accountOptions} />}
        <Checkbox label="Show archived" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      </div>
      {archived && archivedQ.error ? <ErrorBanner error={archivedQ.error} onRetry={archivedQ.reload} title="Could not load archived tasks" /> : null}
      <DataTable
        caption={caption}
        columns={cols}
        rows={rows}
        rowKey={(t) => t.id}
        rowHref={(t) => taskDrawerLink(loc.pathname, loc.search, t.id)}
        defaultSort={{ key: 'due', dir: 'asc' }}
        chevron
        fill
        empty={
          filtered ? (
            <EmptyState action={<Button size="sm" onClick={() => { setStatus('open'); setPriority('all'); setCategory('all'); setAccount('all'); setText(''); }}>Clear filters</Button>}>No tasks match these filters.</EmptyState>
          ) : (
            <EmptyState action={<Link className="btn btn--primary btn--sm" to={newLink}><span className="btn__label">+ Task</span></Link>}>{global ? 'No open tasks.' : 'No open tasks for this account.'}</EmptyState>
          )
        }
      />
      {confirming && (
        <ConfirmDialog
          title="Complete this task?" objectName={confirming.task}
          description={confirming.client_id ? `Account: ${accountById(confirming.client_id)?.name ?? 'Unknown'}` : 'No account'}
          confirmLabel="Yes, complete" cancelLabel="No" tone="neutral" busy={completing}
          onConfirm={() => void complete(confirming)} onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

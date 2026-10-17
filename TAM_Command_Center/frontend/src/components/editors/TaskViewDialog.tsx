import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { PriorityLabel, StatusBadge } from '../ui/Badges';
import { ErrorBanner, RichText, SkeletonRows } from '../ui/Feedback';
import { useApp, useData } from '../../store/DataContext';
import type { Task } from '../../types';
import { accountPath } from '../../lib/links';
import { formatDate, formatTimestamp } from '../../lib/dates';

/** Read-only task popup (opens first everywhere a task is opened). Edit hands over to the edit drawer. */
export function TaskViewDialog({ taskId, onClose, onEdit }: { taskId: string; onClose: () => void; onEdit: () => void }) {
  const { ds } = useData();
  const { state, today, settings, accountById } = useApp();
  const [task, setTask] = useState<Task | null>(() => state.tasks.find((x) => x.id === taskId) ?? null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    const fresh = state.tasks.find((x) => x.id === taskId);
    if (fresh) { setTask(fresh); return; }
    (async () => {
      try {
        const t = (await ds.getTasks({ archived: true })).find((x) => x.id === taskId);
        if (!live) return;
        if (!t) setError(new Error('This task no longer exists.')); else setTask(t);
      } catch (e) { if (live) setError(e); }
    })();
    return () => { live = false; };
  }, [taskId, ds, state.tasks]);

  const acct = task?.client_id ? accountById(task.client_id) : undefined;
  const date = (d: string | null) => (d ? <span className="num">{formatDate(d, today)}</span> : <span className="subtle">-</span>);
  return (
    <Dialog
      title={task?.task ?? 'Task'} width={640} onClose={onClose}
      footer={<><span className="tv-spacer" /><Button onClick={onClose}>Close</Button><Button variant="primary" icon={<Pencil size={14} strokeWidth={1.5} />} disabled={!task} onClick={onEdit}>Edit</Button></>}
    >
      {error ? <ErrorBanner error={error} title="Could not open this task" /> : !task ? <SkeletonRows rows={5} label="Loading task" /> : (
        <div className="tv">
          <dl className="tv-grid">
            <div><dt className="label">Account</dt><dd>{acct ? <Link to={accountPath(acct.id)} className="acct-link">{acct.name}</Link> : <span className="subtle">No account</span>}</dd></div>
            <div><dt className="label">Category</dt><dd>{task.category}</dd></div>
            <div><dt className="label">Priority</dt><dd><PriorityLabel value={task.priority} /></dd></div>
            <div><dt className="label">Status</dt><dd><StatusBadge value={task.status} />{task.archived ? <span className="tag"> Archived</span> : null}</dd></div>
            <div><dt className="label">Due</dt><dd>{date(task.due)}</dd></div>
            <div><dt className="label">Next update</dt><dd>{date(task.next_update)}</dd></div>
            <div><dt className="label">Waiting on</dt><dd>{task.waiting ? task.waiting : <span className="subtle">-</span>}</dd></div>
            <div><dt className="label">Created</dt><dd className="num">{formatTimestamp(task.created_at, settings.time_display, today)}</dd></div>
            <div><dt className="label">Updated</dt><dd className="num">{formatTimestamp(task.updated_at, settings.time_display, today)}</dd></div>
          </dl>
          <section aria-label="Notes">
            <h3 className="label tv-notes__h">Notes</h3>
            {task.notes ? <RichText text={task.notes} className="tv-notes" /> : <p className="subtle">No notes</p>}
          </section>
        </div>
      )}
    </Dialog>
  );
}

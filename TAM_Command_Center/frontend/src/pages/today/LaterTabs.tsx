import { Fragment, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Count, DateCell } from '../../components/ui/Badges';
import { EmptyState } from '../../components/ui/Feedback';
import type { AccountLoadRow, QueueItem, RecentChange } from '../../types';
import { accountPath, queueTarget } from '../../lib/links';
import { dayHeading, diffDays, formatTimestamp, instantLocalDate, type TimeDisplay } from '../../lib/dates';
import { cx } from '../../lib/cx';

export const LOAD_MAX_ROWS = 8;
type TabId = 'upcoming' | 'changed' | 'load';

function UpcomingList({ items, today }: { items: QueueItem[]; today: string }) {
  if (items.length === 0) return <EmptyState>Nothing scheduled in the next two weeks.</EmptyState>;
  const groups: { date: string; items: QueueItem[] }[] = [];
  for (const i of items) {
    const d = i.date ? (i.date_kind === 'opened' ? instantLocalDate(i.date) : i.date.slice(0, 10)) : '';
    const g = groups[groups.length - 1];
    if (g && g.date === d) g.items.push(i);
    else groups.push({ date: d, items: [i] });
  }
  return (
    <ul className="upcoming">
      {groups.map((g) => (
        <Fragment key={g.date || 'none'}>
          <li className="upcoming__day label" role="presentation">{g.date ? dayHeading(g.date, today) : 'NO DATE'}</li>
          {g.items.map((i) => (
            <li key={`${i.kind}-${i.id}`} className="upcoming__item">
              <span className="upcoming__type label">{i.kind === 'task' ? 'Task' : i.kind === 'client_follow_up' ? 'Client touch' : 'Upgrade'}</span>
              <Link to={queueTarget(i)} className="upcoming__title truncate" title={i.title}>{i.title}</Link>
              <span className="upcoming__acct truncate muted">{i.client_name ?? 'No account'}</span>
            </li>
          ))}
        </Fragment>
      ))}
    </ul>
  );
}

function RecentList({ rows, today, tz }: { rows: RecentChange[]; today: string; tz: TimeDisplay }) {
  if (rows.length === 0) return <EmptyState>No recent changes.</EmptyState>;
  return (
    <ul className="recent">
      {rows.map((r) => {
        const to = r.client_id ? accountPath(r.client_id, 'activity') : '/today';
        const when = diffDays(instantLocalDate(r.ts), today) === 0 ? formatTimestamp(r.ts, tz).slice(7) : formatTimestamp(r.ts, tz).slice(0, 6);
        return (
          <li key={r.entry_key} className="recent__item">
            <time className="recent__time num muted" dateTime={r.ts} title={formatTimestamp(r.ts, tz, today)}>{when}</time>
            <Link to={to} className="recent__text" title={`${r.client_name ?? ''} · ${r.sentence}`}>
              <strong className="recent__acct">{r.client_name ?? 'Deleted account'}</strong>
              <span className="muted"> · {r.sentence}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** D-30: a tab-bar panel, always visible, collapsed by default. Click a tab to open it, click it again to collapse. */
export function LaterTabs({ upcoming, recent, load, activeAccounts, today, tz }: {
  upcoming: QueueItem[]; recent: RecentChange[]; load: AccountLoadRow[]; activeAccounts: number; today: string; tz: TimeDisplay;
}) {
  const [open, setOpen] = useState<TabId | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabs: { id: TabId; label: string }[] = [
    { id: 'upcoming', label: `Upcoming (${upcoming.length})` },
    { id: 'changed', label: `Recently changed (${recent.length})` },
    { id: 'load', label: 'Account load' },
  ];
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    refs.current[n]?.focus();
  };
  const loadRows = load.slice(0, LOAD_MAX_ROWS);
  const loadCols: Column<AccountLoadRow>[] = [
    { key: 'name', header: 'Account', primary: true, cell: (r) => r.client_name },
    { key: 'open', header: 'Open', align: 'right', cell: (r) => <Count value={r.open_tasks} /> },
    { key: 'overdue', header: 'Overdue', align: 'right', cell: (r) => <span className={cx('num', r.overdue > 0 ? 'danger-text' : 'subtle')}>{r.overdue}</span> },
    { key: 'waiting', header: 'Waiting', align: 'right', cell: (r) => <Count value={r.waiting} /> },
    { key: 'alerts', header: 'Alerts', align: 'right', cell: (r) => <span className={cx('num', r.active_alerts > 0 ? 'warning-text' : 'subtle')}>{r.active_alerts}</span> },
    { key: 'next', header: 'Next contact', align: 'right', cell: (r) => (r.next_contact ? <DateCell date={r.next_contact} today={today} kind="plain" /> : <span className="subtle">-</span>) },
  ];
  return (
    <section className="panel later" aria-label="Later">
      <div className="later__bar">
        <span className="label later__title">Later</span>
        <div role="tablist" aria-label="Later" className="later__tabs">
          {tabs.map((t, i) => {
            const sel = open === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => (refs.current[i] = el)}
                type="button"
                role="tab"
                id={`later-tab-${t.id}`}
                aria-selected={sel}
                aria-controls="later-panel"
                tabIndex={sel || (open === null && i === 0) ? 0 : -1}
                className={cx('later__tab', sel && 'is-selected')}
                onClick={() => setOpen(sel ? null : t.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {open === null && <span className="later__hint muted sm">Collapsed to keep this screen calm</span>}
      </div>
      {open && (
        <div id="later-panel" role="tabpanel" aria-labelledby={`later-tab-${open}`} className="later__body">
          {open === 'upcoming' && <UpcomingList items={upcoming} today={today} />}
          {open === 'changed' && <RecentList rows={recent} today={today} tz={tz} />}
          {open === 'load' && (
            <>
              <DataTable caption="Account load" columns={loadCols} rows={loadRows} rowKey={(r) => r.client_id} rowHref={(r) => accountPath(r.client_id)} chevron empty="No active accounts." />
              <div className="later__more">
                <Link to="/accounts" className="more-link">All accounts ({activeAccounts}) <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" /></Link>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

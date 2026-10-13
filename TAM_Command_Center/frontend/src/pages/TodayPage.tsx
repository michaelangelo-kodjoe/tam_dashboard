import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlarmClock, ArrowUpCircle, CalendarCheck, CalendarClock, ChevronRight, Hourglass, RefreshCw, Siren, type LucideIcon,
} from 'lucide-react';
import { Panel, PageHeader } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { DataTable, type Column } from '../components/ui/DataTable';
import { Count, DateCell, PriorityLabel } from '../components/ui/Badges';
import { EmptyState, ErrorBanner, SkeletonRows, StaleDataBanner } from '../components/ui/Feedback';
import { useApp, useQuery } from '../store/DataContext';
import type { AccountLoadRow, QueueItem, RecentChange, Urgency } from '../types';
import { accountPath, queueTarget } from '../lib/links';
import { dayHeading, diffDays, formatDate, formatDateLong, formatTimestamp, instantLocalDate, relativeLabel } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { cx } from '../lib/cx';

const URGENCY: Record<Urgency, { icon: LucideIcon; tone: string; text: string }> = {
  overdue: { icon: AlarmClock, tone: 'danger', text: 'Overdue' },
  critical: { icon: Siren, tone: 'danger', text: 'Critical' },
  due_today: { icon: CalendarCheck, tone: 'accent', text: 'Due today' },
  alert: { icon: Siren, tone: 'warning', text: 'Alert' },
  recovered: { icon: Siren, tone: 'neutral', text: 'Recovered' },
  waiting: { icon: Hourglass, tone: 'warning', text: 'Waiting' },
  follow_up: { icon: CalendarClock, tone: 'info', text: 'Follow-up' },
  upgrade: { icon: ArrowUpCircle, tone: 'info', text: 'Upgrade' },
  validation: { icon: ArrowUpCircle, tone: 'warning', text: 'Validation' },
  upcoming: { icon: CalendarClock, tone: 'neutral', text: 'Upcoming' },
};

function AccountLink({ item }: { item: { client_id: string | null; client_name: string | null } }) {
  if (!item.client_id) return <span className="subtle">No account</span>;
  return <Link className="acct-link" to={accountPath(item.client_id)}>{item.client_name}</Link>;
}

/** Right-hand status + date column of a queue row. */
function QueueWhen({ item, today, tz }: { item: QueueItem; today: string; tz: 'local' | 'gmt' }) {
  if (item.kind === 'bams_alert' && item.date) {
    const label = item.status === 'recovered' ? 'recovered' : 'opened';
    return <span className="num">{label} {formatTimestamp(item.date, tz, today)}</span>;
  }
  if (!item.date) return <span className="subtle">-</span>;
  const rel = relativeLabel(item.days_delta);
  return (
    <span className="num">
      <DateCell date={item.date} today={today} kind={item.date_kind === 'due' || item.date_kind === 'next_update' || item.date_kind === 'next_contact' ? 'due' : 'plain'} showRelative />
      <span className="sr-only"> {rel.text}</span>
    </span>
  );
}

function StatusText({ item }: { item: QueueItem }) {
  if (item.kind === 'bams_alert') {
    if (item.status === 'recovered') return <span className="muted">Recovered · close pending</span>;
    return <span className={item.severity === 'Critical' ? 'danger-text' : item.severity === 'Warning' ? 'warning-text' : 'info-text'}>{item.severity}</span>;
  }
  if (item.kind === 'task') return <PriorityLabel value={item.priority} />;
  if (item.kind === 'client_follow_up') return <span className="muted">Client touch</span>;
  return <span className="muted">{item.status}</span>;
}

function QueueRow({ item, today, tz }: { item: QueueItem; today: string; tz: 'local' | 'gmt' }) {
  const navigate = useNavigate();
  const u = URGENCY[item.urgency];
  const Icon = u.icon;
  const target = queueTarget(item);
  return (
    <li
      className={cx('qrow', `qrow--${u.tone}`)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        navigate(target);
      }}
    >
      <span className="qrow__mark" title={u.text}>
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">{u.text}</span>
      </span>
      <span className="qrow__acct truncate"><AccountLink item={item} /></span>
      <span className="qrow__type label">{item.kind === 'server_upgrade' ? 'Upgrade' : item.type_label}</span>
      <span className="qrow__title truncate">
        <Link className="qrow__link" to={target} title={item.title}>{item.title}</Link>
      </span>
      <span className="qrow__status"><StatusText item={item} /></span>
      <span className="qrow__when"><QueueWhen item={item} today={today} tz={tz} /></span>
      <span className="qrow__ctx truncate muted" title={item.context ?? undefined}>{item.context ?? ''}</span>
      <ChevronRight size={16} strokeWidth={1.5} className="qrow__chev" aria-hidden="true" />
    </li>
  );
}

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

function RecentList({ rows, today, tz }: { rows: RecentChange[]; today: string; tz: 'local' | 'gmt' }) {
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

export function TodayPage() {
  useDocumentTitle('Today');
  const { settings, today: appToday } = useApp();
  const ms = settings.auto_refresh_minutes === 'off' ? null : Number(settings.auto_refresh_minutes) * 60_000;
  const q = useQuery('today', (ds) => ds.getToday(), { refreshMs: ms });
  const tz = settings.time_display;
  const today = q.data?.today ?? appToday;

  const loadCols: Column<AccountLoadRow>[] = [
    { key: 'name', header: 'Account', primary: true, cell: (r) => r.client_name },
    { key: 'open', header: 'Open', align: 'right', cell: (r) => <Count value={r.open_tasks} /> },
    { key: 'overdue', header: 'Overdue', align: 'right', cell: (r) => <span className={cx('num', r.overdue > 0 ? 'danger-text' : 'subtle')}>{r.overdue}</span> },
    { key: 'waiting', header: 'Waiting', align: 'right', cell: (r) => <Count value={r.waiting} /> },
    { key: 'alerts', header: 'Alerts', align: 'right', cell: (r) => <span className={cx('num', r.active_alerts > 0 ? 'warning-text' : 'subtle')}>{r.active_alerts}</span> },
    { key: 'next', header: 'Next contact', align: 'right', cell: (r) => (r.next_contact ? <DateCell date={r.next_contact} today={today} kind="plain" /> : <span className="subtle">-</span>) },
  ];

  const tiers: { tier: number; label: string; items: QueueItem[] }[] = [];
  for (const i of q.data?.queue ?? []) {
    const g = tiers[tiers.length - 1];
    if (g && g.tier === i.tier) g.items.push(i);
    else tiers.push({ tier: i.tier!, label: i.tier_label!, items: [i] });
  }
  const total = q.data?.queue.length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title={<>Today <span className="pagehead__date">· {formatDateLong(today)} {today.slice(0, 4)}</span></>}
        actions={
          <span className="refresh muted">
            {q.lastOk ? `Last refreshed ${formatTimestamp(q.lastOk.toISOString(), tz).slice(7)}` : 'Not refreshed yet'}
            <Button variant="icon" size="sm" aria-label="Refresh Today" title="Refresh" onClick={q.reload} icon={<RefreshCw size={16} strokeWidth={1.5} className={q.refreshing ? 'spin' : undefined} />} />
          </span>
        }
      />
      {q.stale && <StaleDataBanner since={q.lastOk ? formatTimestamp(q.lastOk.toISOString(), tz).slice(7) : 'earlier'} onRetry={q.reload} />}
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not load Today" /> : null}
      {q.loading && <SkeletonRows rows={8} label="Loading Today" />}
      {q.data && (
        <div className="today">
          <div className="today__main">
            <Panel title="Work queue" count={total} className="queue-panel" bodyClassName="queue-panel__body">
              {total === 0 ? (
                <EmptyState>
                  Nothing needs attention.
                  {q.data.upcoming[0] ? ` Next item: ${q.data.upcoming[0].title} (${q.data.upcoming[0].client_name ?? 'no account'}, ${formatDate(q.data.upcoming[0].date, today)}).` : ''}
                </EmptyState>
              ) : (
                tiers.map((g) => (
                  <section key={g.tier} aria-label={`${g.label}, ${g.items.length} items`}>
                    <h3 className="tier-head label">{g.label} <span className="num">({g.items.length})</span></h3>
                    <ul className="qlist">
                      {g.items.map((i) => <QueueRow key={`${i.kind}-${i.id}`} item={i} today={today} tz={tz} />)}
                    </ul>
                  </section>
                ))
              )}
            </Panel>
            <Panel title="Account load" className="load-panel" actions={<Link to="/accounts" className="more-link">All accounts <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" /></Link>}>
              <DataTable caption="Account load" columns={loadCols} rows={q.data.account_load} rowKey={(r) => r.client_id} rowHref={(r) => accountPath(r.client_id)} chevron empty="No active accounts." />
            </Panel>
          </div>
          <div className="today__side">
            <Panel title="Upcoming" count={q.data.upcoming.length}>
              <UpcomingList items={q.data.upcoming} today={today} />
            </Panel>
            <Panel title="Recently changed">
              <RecentList rows={q.data.recent_changes} today={today} tz={tz} />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

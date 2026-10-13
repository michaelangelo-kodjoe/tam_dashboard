import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorBanner, SkeletonRows, StaleDataBanner } from '../components/ui/Feedback';
import { ProgressRing, SummaryChips } from '../components/ui/Instruments';
import { useApp, useQuery } from '../store/DataContext';
import type { QueueItem, TodayProgress } from '../types';
import { queueTarget } from '../lib/links';
import { formatDate, formatDateLong, formatTimestamp, localToday } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';
import { buildChips, effectiveShow, itemKey, parseShow, reconcileSelection, scopeItems, type Show } from '../lib/triage';
import { TriageList } from './today/TriageList';
import { TriageDetail } from './today/TriageDetail';
import { LaterTabs } from './today/LaterTabs';

function Progress({ p }: { p: TodayProgress | null }) {
  if (!p) return null;
  if (p.total === 0) return <span className="progress muted" data-testid="progress">No tasks due today</span>;
  const all = p.done >= p.total;
  const tip = p.done_other > 0 ? `+${p.done_other} other ${p.done_other === 1 ? 'task' : 'tasks'} completed` : undefined;
  return (
    <span className="progress" data-testid="progress" title={tip}>
      <ProgressRing done={p.done} total={p.total} />
      <span className="progress__text">
        <span className="num">{p.done} of {p.total} tasks done</span>
        {all && <span className="progress__all muted"> · All done</span>}
      </span>
    </span>
  );
}

export function TodayPage() {
  useDocumentTitle('Today');
  const { settings, accounts, today: appToday } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ms = settings.auto_refresh_minutes === 'off' ? null : Number(settings.auto_refresh_minutes) * 60_000;
  const q = useQuery('today', (ds) => ds.getToday(), { refreshMs: ms });
  const tz = settings.time_display;
  const today = q.data?.today ?? appToday;

  // The ring resets at local midnight: refetch as soon as the workstation's date changes (§10.2).
  const seenDay = useRef(localToday());
  const { reload } = q;
  useEffect(() => {
    const check = () => {
      const now = localToday();
      if (now !== seenDay.current) { seenDay.current = now; reload(); }
    };
    const h = setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(h); document.removeEventListener('visibilitychange', check); };
  }, [reload]);

  const queue = q.data?.queue ?? [];
  const requested = parseShow(params.get('show'));
  const show: Show = effectiveShow(requested, queue);
  const items = scopeItems(queue, show);
  const chips = buildChips(queue);

  const [sel, setSel] = useState<{ key: string | null; idx: number }>({ key: null, idx: 0 });
  const idx = reconcileSelection(items, sel.key, sel.idx);
  const selected: QueueItem | undefined = idx >= 0 ? items[idx] : undefined;

  const setShow = useCallback((s: Show) => {
    setSel({ key: null, idx: 0 });
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      if (s === 'top') n.delete('show'); else n.set('show', s);
      return n;
    });
  }, [setParams]);

  const select = (i: number) => setSel({ key: items[i] ? itemKey(items[i]) : null, idx: i });
  const open = (item: QueueItem) => navigate(queueTarget(item));

  const activeAccounts = accounts.filter((a) => a.status === 'Active').length;
  const next = q.data?.upcoming[0];

  return (
    <div className="page today">
      <PageHeader
        title={<>Today <span className="pagehead__date">· {formatDateLong(today)} {today.slice(0, 4)}</span></>}
        actions={
          <>
            <Progress p={q.data?.progress ?? null} />
            <span className="refresh muted">
              {q.lastOk ? `Last refreshed ${formatTimestamp(q.lastOk.toISOString(), tz).slice(7)}` : 'Not refreshed yet'}
              <Button variant="icon" size="sm" aria-label="Refresh Today" title="Refresh" onClick={q.reload} icon={<RefreshCw size={16} strokeWidth={1.5} className={q.refreshing ? 'spin' : undefined} />} />
            </span>
          </>
        }
      />
      {q.stale && <StaleDataBanner since={q.lastOk ? formatTimestamp(q.lastOk.toISOString(), tz).slice(7) : 'earlier'} onRetry={q.reload} />}
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not load Today" /> : null}
      {q.loading && (
        <div className="triage" aria-busy="true">
          <div className="panel triage__list"><SkeletonRows rows={8} label="Loading Today" /></div>
          <div className="panel triage__detail"><SkeletonRows rows={5} label="Loading detail" /></div>
        </div>
      )}
      {q.data && (
        <>
          <SummaryChips chips={chips} value={show} onChange={setShow} label="Queue groups" />
          {queue.length === 0 ? (
            <section className="panel" aria-label="Work queue">
              <EmptyState>
                Nothing needs attention.
                {next ? ` Next item: ${next.title} (${next.client_name ?? 'no account'}, ${formatDate(next.date, today)}).` : ''}
              </EmptyState>
            </section>
          ) : (
            <div className="triage">
              <TriageList items={items} total={queue.length} show={show} selected={idx} onSelect={select} onOpen={open} onViewAll={() => setShow('all')} today={today} tz={tz} />
              {selected && <TriageDetail item={selected} today={today} tz={tz} />}
            </div>
          )}
          <LaterTabs upcoming={q.data.upcoming} recent={q.data.recent_changes} load={q.data.account_load} activeAccounts={activeAccounts} today={today} tz={tz} />
        </>
      )}
    </div>
  );
}

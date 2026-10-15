import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { ErrorBanner, SkeletonRows, StaleDataBanner } from '../../components/ui/Feedback';
import { StatusBadge } from '../../components/bams/BamsBits';
import { TabStrip } from '../../components/bams/TabStrip';
import { useApp, useQuery } from '../../store/DataContext';
import { useDocumentTitle } from '../../lib/hooks';
import { formatStamp, formatTime, formatValue } from '../../lib/bams';
import { cx } from '../../lib/cx';
import type { BamsAlertItem } from '../../bamsTypes';
import { REFRESH_MS } from './common';
import { CloseAlertDialog, type CloseTarget } from './CloseAlertDialog';

type Tab = 'active' | 'closed';

/** Alerts view (mockup 04): open and recovered alerts need a human; closed history below. */
export function AlertsPage() {
  useDocumentTitle('BAMS alerts');
  const { settings } = useApp();
  const tz = settings.time_display;
  const [sp] = useSearchParams();
  const eventId = sp.get('event');
  const account = sp.get('account') || undefined;
  const q = useQuery(`bams-alerts:${account ?? ''}`, (d) => d.getBamsAlerts({ status: 'all', account, limit: 200 }), { refreshMs: REFRESH_MS });
  const inClosed = !!eventId && !!q.data?.items.some((i) => i.event.id === eventId && i.event.status === 'closed');
  const [tab, setTab] = useState<Tab>('active');
  const [closing, setClosing] = useState<CloseTarget | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (inClosed) setTab('closed'); }, [inClosed]);
  useEffect(() => {
    if (!q.data || !eventId) return;
    rootRef.current?.querySelector<HTMLElement>('tr.is-highlight')?.scrollIntoView({ block: 'center' });
  }, [q.data, eventId, tab]);

  const active = q.data?.items.filter((i) => i.event.status !== 'closed') ?? [];
  const closed = q.data?.items.filter((i) => i.event.status === 'closed') ?? [];
  const missing = !!eventId && !!q.data && !q.data.items.some((i) => i.event.id === eventId);

  const target = (i: BamsAlertItem): CloseTarget => ({ event: i.event, appliance: `${i.object.client_name} / ${i.object.name}`, metric: i.metric.metric_name });

  return (
    <div className="page bm-page" ref={rootRef}>
      <PageHeader title="BAMS alerts" meta="Open and recovered alerts need a human" actions={<Link to="/bams" className="btn btn--ghost btn--md"><span className="btn__label">Back to dashboard</span></Link>} />
      {q.loading && <SkeletonRows rows={5} label="Loading alerts" />}
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not load alerts" /> : null}
      {q.stale && <StaleDataBanner since={q.lastOk ? formatTime(q.lastOk.toISOString(), tz, true) : 'earlier'} onRetry={q.reload} />}
      {missing && <div role="status" className="banner banner--warning"><div className="banner__body">That alert is no longer listed. It may belong to an appliance that was disabled or deleted.</div></div>}
      {q.data && (
        <>
          <div className="bm-bar">
            <TabStrip label="Alert views" value={tab} onChange={setTab} items={[{ id: 'active', label: 'Needs action', count: q.data.counts.active }, { id: 'closed', label: 'Closed history', count: q.data.counts.closed }]} />
          </div>
          {tab === 'active' ? (
            <>
              <Panel bodyClassName="bm-tablebody">
                <AlertTable items={active} tz={tz} eventId={eventId} empty="No open or recovered alerts. Nothing needs action." onClose={(i) => setClosing(target(i))} />
              </Panel>
              {closed.length > 0 && (
                <>
                  <div className="label bm-subhead">Closed history (latest {Math.min(5, closed.length)})</div>
                  <Panel bodyClassName="bm-tablebody"><AlertTable items={closed.slice(0, 5)} tz={tz} eventId={eventId} empty="" dim /></Panel>
                </>
              )}
            </>
          ) : (
            <Panel bodyClassName="bm-tablebody"><AlertTable items={closed} tz={tz} eventId={eventId} empty="No closed alerts yet." dim /></Panel>
          )}
        </>
      )}
      {closing && <CloseAlertDialog target={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function AlertTable({ items, tz, eventId, empty, dim, onClose }: { items: BamsAlertItem[]; tz: 'local' | 'gmt'; eventId: string | null; empty: string; dim?: boolean; onClose?: (i: BamsAlertItem) => void }) {
  if (items.length === 0) return <p className="bm-empty muted">{empty}</p>;
  return (
    <div className="table-scroll bm-tbl bm-tbl--wrap">
      <table className={cx('table table--compact', dim && 'bm-dim')}>
        <caption className="sr-only">{dim ? 'Closed alerts' : 'Alerts that need action'}</caption>
        <thead><tr><th scope="col">State</th><th scope="col">Appliance</th><th scope="col">Metric</th><th scope="col" className="is-right">Value</th><th scope="col">Timing</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {items.map((i) => {
            const e = i.event;
            return (
              <tr key={e.id} className={cx(e.id === eventId && 'is-highlight', e.status === 'open' && 'bm-row--open', e.status === 'recovered' && 'bm-row--recovered')} data-event={e.id}>
                <td>{e.status === 'closed' ? <span className="badge badge--neutral">Closed</span> : <StatusBadge status={e.status === 'open' ? 'open' : 'recovered'} label={`${e.status === 'open' ? 'Open' : 'Recovered'} · ${e.severity}`} />}</td>
                <td>{i.object.client_name} / <span className="mono">{i.object.name}</span></td>
                <td>{e.message}</td>
                <td className="is-right num">{e.status === 'closed' ? `peak ${formatValue(e.peak_value)}` : `peak ${formatValue(e.peak_value)} / now ${i.freshness === 'No Data' ? 'no data' : formatValue(e.current_value)}`}</td>
                <td className="muted">
                  {e.status === 'closed' ? `${formatStamp(e.opened_at, tz)} to ${formatTime(e.closed_at, tz)}` : e.status === 'recovered' ? `opened ${formatTime(e.opened_at, tz)} · recovered ${formatTime(e.recovered_at, tz)}, awaiting close` : `opened ${formatTime(e.opened_at, tz)}${e.last_triggered_at ? ` · last ${formatTime(e.last_triggered_at, tz)}` : ''}`}
                </td>
                <td>{e.status === 'closed' ? (e.closed_note ? <span className="bm-note sm" title={e.closed_note}>Closed: {e.closed_note}</span> : <span className="subtle sm">No note</span>) : <Button size="sm" onClick={() => onClose?.(i)}>Close</Button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

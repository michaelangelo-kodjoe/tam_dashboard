import { Suspense, lazy, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, X } from 'lucide-react';
import { Overlay } from '../../components/ui/Overlay';
import { Button } from '../../components/ui/Button';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { FreshnessBadge, SeverityTag, SimulatedBadge, StatusBadge } from '../../components/bams/BamsBits';
import { useApp, useQuery } from '../../store/DataContext';
import { TREND_RANGES, type BamsAlertEvent, type BamsRow, type TrendRange } from '../../bamsTypes';
import { formatAge, formatHighDate, formatStamp, formatValue, ruleCondition } from '../../lib/bams';
import { useMediaQuery } from '../../lib/hooks';
import { REFRESH_MS } from './common';
const TrendChart = lazy(() => import('./TrendChart').then((m) => ({ default: m.TrendChart })));
import { CloseAlertDialog, type CloseTarget } from './CloseAlertDialog';

const RANGE_TEXT: Record<TrendRange, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days' };

/** Metric detail drawer (mockup 03): value, highs, Recharts trend with text equivalent, rules, alert history. */
export function MetricDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (objectId: string) => void }) {
  const tid = useId();
  const { settings } = useApp();
  const [range, setRange] = useState<TrendRange>('7d');
  const [closing, setClosing] = useState<CloseTarget | null>(null);
  const detail = useQuery(`bams-metric:${id}`, (d) => d.getBamsMetric(id), { refreshMs: REFRESH_MS });
  const trend = useQuery(`bams-trend:${id}:${range}`, (d) => d.getBamsTrend(id, range), { refreshMs: REFRESH_MS });
  const [zoomWin, setZoomWin] = useState<[number, number] | null>(null);
  useEffect(() => { setZoomWin(null); }, [id, range]);
  const fromIso = zoomWin ? new Date(zoomWin[0]).toISOString() : '';
  const toIso = zoomWin ? new Date(zoomWin[1]).toISOString() : '';
  // finer samples for the zoom window; cached per window, the previous window's data stays up while the next one loads
  const winQ = useQuery(`bams-trend-win:${id}:${fromIso}:${toIso}`, (d) => d.getBamsTrendWindow(id, fromIso, toIso), { enabled: !!zoomWin, keepPrevious: true });
  const row: BamsRow | undefined = detail.data?.row;
  const tz = settings.time_display;
  const tall = useMediaQuery('(min-height: 760px)');

  return (
    <>
      <Overlay variant="drawer" labelledBy={tid} onClose={onClose} closable={!closing} className="bm-drawer">
        <header className="overlay__head bm-drawer__head">
          <div className="overlay__titles">
            <span className="label">{row ? `${row.object.client_name}${row.object.location ? ` · ${row.object.location}` : ''}` : 'Metric'}</span>
            <h2 id={tid} className="overlay__title">{row ? `${row.object.name} · ${row.metric_name}` : 'Metric detail'}</h2>
            {row && (
              <div className="bm-badges">
                {row.simulated && <SimulatedBadge />}
                {row.alert && <StatusBadge status={row.alert.status === 'open' ? 'open' : 'recovered'} severity={row.alert.severity} label={`${row.alert.status === 'open' ? 'Open alert' : 'Recovered, awaiting close'} · ${row.alert.severity}`} />}
                <FreshnessBadge freshness={row.freshness} />
                <span className="muted num">{row.age_seconds == null ? 'never updated' : `${formatAge(row.age_seconds)} ago`}</span>
              </div>
            )}
          </div>
          <Button variant="icon" size="sm" aria-label="Close metric detail" title="Close" onClick={onClose} icon={<X size={16} strokeWidth={1.5} />} />
        </header>
        <div className="overlay__body overlay__body--scroll">
          {detail.loading && <SkeletonRows rows={6} label="Loading metric" />}
          {detail.error ? <ErrorBanner error={detail.error} onRetry={detail.reload} title="Could not load this metric" /> : null}
          {detail.data && row && (
            <>
              <div className="bm-now">
                <span className={`bm-now__v num ${row.display_status === 'open' ? 'bm-danger' : ''}`}>{row.current_value == null ? 'No data' : formatValue(row.current_value)}</span>
                <span className="muted">now · ticker <span className="mono">{row.ticker}</span></span>
              </div>
              <div className="bm-highs">
                {([['30D high', row.highs.d30], ['60D high', row.highs.d60], ['90D high', row.highs.d90]] as const).map(([l, h]) => (
                  <div key={l} className="bm-kpi bm-kpi--sm">
                    <span className="label">{l}</span>
                    <b className="num">{h.value == null ? '-' : formatValue(h.value)}</b>
                    <span className="muted sm">{h.date ? formatHighDate(h.date) : ''}</span>
                  </div>
                ))}
              </div>
              <div className="bm-trendhead">
                <span className="label">Trend</span>
                <span className="bm-bar__spacer" />
                <SegmentedControl size="sm" label="Trend range" value={range} onChange={setRange} options={TREND_RANGES.map((r) => ({ value: r, label: r === '24h' ? '24 h' : r.replace('d', ' d') }))} />
              </div>
              {trend.loading && <SkeletonRows rows={3} label="Loading trend" />}
              {trend.error ? <ErrorBanner error={trend.error} onRetry={trend.reload} title="Could not load the trend" /> : null}
              {trend.data && (
                <>
                  <Suspense fallback={<SkeletonRows rows={3} label="Loading chart" />}><TrendChart trend={trend.data} rules={detail.data?.rules ?? []} height={tall ? 420 : 300} onZoom={setZoomWin} windowFetch={{ data: zoomWin ? winQ.data : null, loading: !!zoomWin && (winQ.loading || winQ.refreshing), error: zoomWin ? winQ.error : null }} /></Suspense>
                  <p className="muted sm bm-textequiv">
                    {trend.data.text.count === 0
                      ? `Text equivalent: no values stored for the last ${RANGE_TEXT[range]}.`
                      : `Text equivalent: min ${formatValue(trend.data.text.min)}, max ${formatValue(trend.data.text.max)}, last ${formatValue(trend.data.text.last)} (${RANGE_TEXT[range]}, ${trend.data.text.count.toLocaleString('en-US')} points).${trend.data.rule_lines.length ? ` ${trend.data.rule_lines.map((l) => `${l.label}%`).join('; ')}.` : ''}`}
                  </p>
                </>
              )}
              <div className="bm-sectionhead">
                <span className="label">Rules on this metric</span>
                <span className="bm-bar__spacer" />
                <Link to={`/bams/config?metric=${row.id}`} className="btn btn--ghost btn--sm"><span className="btn__label">Edit rules</span></Link>
              </div>
              {detail.data.rules.length === 0 ? (
                <p className="muted sm">No rules yet. Add one in Alert configuration.</p>
              ) : (
                <ul className="bm-list">
                  {detail.data.rules.map((r) => (
                    <li key={r.id} className="bm-list__row">
                      <span>{ruleCondition(r)} for {r.consecutive_updates} {r.consecutive_updates === 1 ? 'update' : 'updates'}</span>
                      <SeverityTag severity={r.severity} />
                      <span className="muted">cooldown {r.cooldown_minutes} m</span>
                      <span className={`badge ${r.enabled ? 'badge--success' : 'badge--neutral'}`}>{r.enabled ? 'Enabled' : 'Disabled'}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="bm-sectionhead"><span className="label">Alert history for this metric</span><span className="bm-bar__spacer" /><span className="muted sm num">{detail.data.alerts_total} total</span></div>
              {detail.data.alerts.length === 0 ? (
                <p className="muted sm">No alerts have been raised on this metric.</p>
              ) : (
                <ul className="bm-list bm-events">
                  {detail.data.alerts.map((a) => <EventRow key={a.id} a={a} tz={tz} onClose={() => setClosing({ event: a, appliance: `${row.object.client_name} / ${row.object.name}`, metric: row.metric_name })} />)}
                </ul>
              )}
            </>
          )}
        </div>
        {row && (
          <footer className="overlay__foot overlay__foot--drawer">
            <Button icon={<Pencil size={14} strokeWidth={1.5} />} onClick={() => onEdit(row.object.id)}>Edit appliance</Button>
          </footer>
        )}
      </Overlay>
      {closing && <CloseAlertDialog target={closing} onClose={() => setClosing(null)} />}
    </>
  );
}

function EventRow({ a, tz, onClose }: { a: BamsAlertEvent; tz: 'local' | 'gmt'; onClose: () => void }) {
  const active = a.status !== 'closed';
  return (
    <li className="bm-list__row bm-event">
      <div className="bm-event__main">
        <div>
          <b>{a.status === 'open' ? 'Open' : a.status === 'recovered' ? 'Recovered' : 'Closed'}</b> {a.severity}, peak {formatValue(a.peak_value)} · opened {formatStamp(a.opened_at, tz)}
          {a.closed_at ? ` to ${formatStamp(a.closed_at, tz)}` : a.recovered_at ? `, recovered ${formatStamp(a.recovered_at, tz)}` : ''}
        </div>
        <div className="muted sm">{a.message}{a.rule_summary && !a.message.includes(a.rule_summary) ? ` (${a.rule_summary})` : ''}</div>
        {a.closed_note && <div className="bm-note sm">Closed by you: {a.closed_note}</div>}
      </div>
      {active && <Button size="sm" onClick={onClose}>Close alert</Button>}
    </li>
  );
}

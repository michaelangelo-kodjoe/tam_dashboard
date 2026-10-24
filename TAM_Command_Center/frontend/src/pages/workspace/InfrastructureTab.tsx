import { useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { Panel } from '../../components/ui/Panel';
import { EmptyState, ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { FreshnessBadge, RowStatus, SimulatedBadge, StatusBadge, Value } from '../../components/bams/BamsBits';
import { useQuery } from '../../store/DataContext';
import type { BamsRow } from '../../bamsTypes';
import { formatAge } from '../../lib/bams';
import { cx } from '../../lib/cx';
import { REFRESH_MS } from '../bams/common';

/**
 * Appliances (BAMS) show live status and active alert counts per appliance with an Open in BAMS link (mockup 08);
 * upgrades are not listed here (Operations owns them; the Overview shows the next 30 days). `?server=` highlights and scrolls to a matching appliance.
 */
export function InfrastructureTab({ clientId }: { clientId: string }) {
  const [params] = useSearchParams();
  const server = params.get('server')?.trim().toLowerCase() ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const match = (name: string) => !!server && name.trim().toLowerCase() === server;
  const bams = useQuery(`bams-infra:${clientId}`, (d) => d.getBamsState({ account: clientId, include_disabled: true, spark: false, sort: 'appliance' }), { refreshMs: REFRESH_MS });
  const alerts = useQuery(`bams-infra-alerts:${clientId}`, (d) => d.getBamsAlerts({ status: 'active', account: clientId }), { refreshMs: REFRESH_MS });

  const groups = useMemo(() => {
    const by = new Map<string, { object: BamsRow['object']; rows: BamsRow[] }>();
    for (const r of bams.data?.rows ?? []) {
      if (!by.has(r.object.id)) by.set(r.object.id, { object: r.object, rows: [] });
      by.get(r.object.id)!.rows.push(r);
    }
    return [...by.values()];
  }, [bams.data]);

  useEffect(() => {
    if (!server || !bams.data) return;
    rootRef.current?.querySelector<HTMLElement>('.is-highlight')?.scrollIntoView({ block: 'center' });
  }, [bams.data, server]);

  const ac = alerts.data?.counts;

  return (
    <div className="infra" ref={rootRef}>
      {ac && ac.active > 0 && (
        <div role="status" className="banner banner--danger bm-infra-banner">
          <ShieldAlert size={16} strokeWidth={1.5} aria-hidden="true" />
          <div className="banner__body"><b>{ac.active} active {ac.active === 1 ? 'alert' : 'alerts'}</b> on this account ({ac.open} open, {ac.recovered} recovered awaiting close). Matches the BAMS page count for this account.</div>
          <Link to={`/bams?account=${clientId}&view=active_alerts`} className="btn btn--secondary btn--sm"><span className="btn__label">Open in BAMS</span><span className="btn__icon"><ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" /></span></Link>
        </div>
      )}
      {bams.loading && <SkeletonRows rows={4} label="Loading monitored appliances" />}
      {bams.error ? <ErrorBanner error={bams.error} onRetry={bams.reload} title="Could not load monitored appliances" /> : null}
      {bams.data && groups.length === 0 && (
        <Panel title="Monitored appliances (BAMS)">
          <EmptyState action={<Link to="/bams" className="btn btn--secondary btn--sm"><span className="btn__label">Open BAMS</span></Link>}>No monitored appliances for this account.</EmptyState>
        </Panel>
      )}
      {groups.map(({ object: o, rows }) => {
        const active = rows.reduce((n, r) => n + r.active_alerts, 0);
        const top = rows.find((r) => r.alert?.status === 'open') ?? rows.find((r) => r.alert);
        const worst = rows.find((r) => r.freshness === 'Stale') ?? rows.find((r) => r.freshness === 'No Data') ?? rows.find((r) => r.freshness === 'Delayed') ?? rows[0];
        const youngest = Math.min(...rows.map((r) => r.age_seconds ?? Infinity));
        return (
          <Panel key={o.id} className={cx('bm-appl-panel', match(o.name) && 'is-highlight')} title={<span className="bm-appl-title"><span className="mono bm-appl-title__name">{o.name}</span><span className="muted sm bm-appl-title__sub">{[o.location, o.environment].filter(Boolean).join(' · ')}</span></span>}
            actions={
              <span className="bm-badges">
                {rows.some((r) => r.simulated) && <SimulatedBadge />}
                {!o.enabled ? <span className="badge badge--neutral">Monitoring disabled</span> : (
                  <>
                    {active > 0 && top?.alert && <StatusBadge status={top.alert.status === 'open' ? 'open' : 'recovered'} severity={top.alert.severity} label={`${active} ${top.alert.status === 'open' ? 'open' : 'recovered'} ${active === 1 ? 'alert' : 'alerts'}`} />}
                    <FreshnessBadge freshness={worst.freshness} />
                    <span className="muted num">{Number.isFinite(youngest) ? formatAge(youngest) : 'never'}</span>
                  </>
                )}
                <Link to={`/bams?account=${clientId}&object_id=${o.id}`} className="btn btn--ghost btn--sm"><span className="btn__label">Open in BAMS</span><span className="btn__icon"><ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" /></span></Link>
              </span>
            }
            bodyClassName="bm-tablebody">
            <div className="table-scroll bm-tbl">
              <table className="table table--compact" aria-label={`${o.name} metrics`}>
                <thead><tr><th scope="col">Metric</th><th scope="col" className="is-right">Current</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.metric_name}</td>
                      <td className="is-right num"><Value value={r.current_value} /></td>
                      <td>{o.enabled ? <><RowStatus row={r} /> <span className="muted num">{formatAge(r.age_seconds)}</span></> : <span className="muted">Disabled</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import { Panel } from '../../components/ui/Panel';
import { DataTable, cmpStr, type Column } from '../../components/ui/DataTable';
import { DateCell, StatusBadge } from '../../components/ui/Badges';
import { EmptyState, ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { useApp, type QueryResult } from '../../store/DataContext';
import type { BamsObject, Infrastructure, ServerUpgrade } from '../../types';
import { cx } from '../../lib/cx';

/** Read-only this run (D-02, US-9.1). `?server=` highlights and scrolls to matching rows. */
export function InfrastructureTab({ q }: { q: QueryResult<Infrastructure> }) {
  const { today } = useApp();
  const [params] = useSearchParams();
  const server = params.get('server')?.trim().toLowerCase() ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const match = (name: string) => !!server && name.trim().toLowerCase() === server;

  useEffect(() => {
    if (!q.data || !server) return;
    const el = rootRef.current?.querySelector<HTMLElement>('tr.is-highlight');
    el?.scrollIntoView({ block: 'center' });
  }, [q.data, server]);

  const bamsCols: Column<BamsObject>[] = [
    { key: 'name', header: 'Appliance', sort: (a, b) => cmpStr(a.name, b.name), cell: (o) => <span className="mono">{o.name}</span> },
    { key: 'region', header: 'Region', sort: (a, b) => cmpStr(a.region, b.region), cell: (o) => o.region ?? <span className="subtle">-</span> },
    { key: 'location', header: 'Location', sort: (a, b) => cmpStr(a.location, b.location), cell: (o) => o.location ?? <span className="subtle">-</span> },
    { key: 'env', header: 'Environment', cell: (o) => o.environment ?? <span className="subtle">-</span> },
    { key: 'enabled', header: 'Monitoring', cell: (o) => (o.enabled ? 'Enabled' : <span className="muted">Disabled</span>) },
    { key: 'status', header: 'Worst metric status', cell: (o) => <StatusBadge value={o.worst_status} /> },
    { key: 'alerts', header: 'Active alerts', align: 'right', cell: (o) => <span className={cx('num', o.active_alerts > 0 ? 'warning-text' : 'subtle')}>{o.active_alerts}</span> },
  ];
  const upCols: Column<ServerUpgrade>[] = [
    { key: 'server', header: 'Server', sort: (a, b) => cmpStr(a.server_name, b.server_name), cell: (u) => <span className="mono">{u.server_name}</span> },
    { key: 'env', header: 'Environment', cell: (u) => `${u.environment} · ${u.polarity}` },
    { key: 'version', header: 'Version', mono: true, cell: (u) => `${u.current_version ?? '?'} → ${u.target_version ?? '?'}` },
    { key: 'date', header: 'Scheduled', align: 'right', sort: (a, b) => cmpStr(a.scheduled_date, b.scheduled_date), cell: (u) => <DateCell date={u.scheduled_date} today={today} kind="plain" /> },
    { key: 'status', header: 'Status', cell: (u) => <StatusBadge value={u.status} /> },
    { key: 'validation', header: 'Validation', cell: (u) => <StatusBadge value={u.validation_status} /> },
    { key: 'waiting', header: 'Waiting on', cell: (u) => u.waiting_on ?? <span className="subtle">-</span> },
  ];

  return (
    <div className="infra" ref={rootRef}>
      <p className="notice"><Info size={16} strokeWidth={1.5} aria-hidden="true" /> Upgrades are managed in Operations; monitoring in BAMS (coming in a later release).</p>
      {q.loading && <SkeletonRows rows={6} label="Loading infrastructure" />}
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not load infrastructure" /> : null}
      {q.data && (
        <>
          <Panel title="Monitored appliances (BAMS)" count={q.data.bams_objects.length}>
            <DataTable caption="Monitored appliances" columns={bamsCols} rows={q.data.bams_objects} rowKey={(o) => o.id} highlight={(o) => match(o.name)} empty={<EmptyState>No monitored appliances for this account.</EmptyState>} defaultSort={{ key: 'name', dir: 'asc' }} />
          </Panel>
          <Panel title="Server upgrades" count={q.data.upgrades.length}>
            <DataTable caption="Server upgrades" columns={upCols} rows={q.data.upgrades} rowKey={(u) => u.id} highlight={(u) => match(u.server_name)} empty={<EmptyState>No server upgrade records for this account.</EmptyState>} defaultSort={{ key: 'date', dir: 'desc' }} />
          </Panel>
        </>
      )}
    </div>
  );
}

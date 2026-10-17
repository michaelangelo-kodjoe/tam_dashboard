import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, Play, Plus, Search, Settings as SettingsIcon, ShieldAlert, Square, Upload } from 'lucide-react';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { Select, type SelectOption } from '../../components/ui/Select';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { ErrorBanner, SkeletonRows, StaleDataBanner } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { Tooltip } from '../../components/ui/Tooltip';
import { RowStatus, SimulatedBadge, Spark, Value } from '../../components/bams/BamsBits';
import { useApp, useData, useQuery } from '../../store/DataContext';
import { useDebounced, useDocumentTitle } from '../../lib/hooks';
import { groupSummary, hasActiveAlert, loadGroupState, saveGroupState } from '../../lib/bamsGroups';
import { formatAge, formatSeconds, formatTime } from '../../lib/bams';
import { cx } from '../../lib/cx';
import { BAMS_VIEWS, type BamsRow, type BamsSortKey, type BamsState, type BamsStateQuery, type BamsStatusFilter, type BamsView } from '../../bamsTypes';
import { TabStrip } from '../../components/bams/TabStrip';
import { Kpi, REFRESH_MS, errText } from './common';
import { MetricDrawer } from './MetricDrawer';
import { ApplianceDialog } from './ApplianceDialog';

const VIEW_LABEL: Record<BamsView, string> = { all: 'All', active_alerts: 'Active Alerts', delayed_stale: 'Delayed / Stale', live: 'Live', no_data: 'No Data' };
const STATUS_OPTIONS: SelectOption[] = [
  { value: 'open', label: 'Open alert' }, { value: 'recovered', label: 'Recovered' }, { value: 'live', label: 'Live' },
  { value: 'delayed', label: 'Delayed' }, { value: 'stale', label: 'Stale' }, { value: 'no_data', label: 'No data' },
];
const SORT_KEYS: BamsSortKey[] = ['status', 'appliance', 'location', 'metric', 'current', 'high30', 'high60', 'high90', 'last_update'];
const FILTER_KEYS = ['account', 'object_id', 'location', 'metric', 'status', 'q'] as const;

export function parseQuery(sp: URLSearchParams): BamsStateQuery {
  const view = sp.get('view') as BamsView | null;
  const sort = sp.get('sort') as BamsSortKey | null;
  const status = sp.get('status') as BamsStatusFilter | null;
  return {
    view: view && BAMS_VIEWS.includes(view) ? view : 'all',
    account: sp.get('account') || undefined, object_id: sp.get('object_id') || undefined, location: sp.get('location') || undefined,
    metric: sp.get('metric') || undefined, status: status && STATUS_OPTIONS.some((o) => o.value === status) ? status : undefined, q: sp.get('q') || undefined,
    sort: sort && SORT_KEYS.includes(sort) ? sort : undefined, dir: sp.get('dir') === 'desc' ? 'desc' : undefined,
  };
}

export function DashboardPage() {
  useDocumentTitle('BAMS');
  const { settings } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const query = useMemo(() => parseQuery(sp), [sp]);
  const key = `bams-state:${[...sp.entries()].filter(([k]) => k !== 'open').map(([k, v]) => `${k}=${v}`).join('&')}`;
  const q = useQuery(key, (d) => d.getBamsState(query), { refreshMs: REFRESH_MS });
  const [dialog, setDialog] = useState<null | { objectId?: string }>(null);
  const [busy, setBusy] = useState(false);
  const openId = sp.get('open');
  const [manual, setManual] = useState<Record<string, boolean>>(loadGroupState);
  const [collapsedWhileFiltered, setCollapsedWhileFiltered] = useState<Set<string>>(new Set());

  const patch = (changes: Record<string, string | null>, opts: { keepOpen?: boolean } = {}) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); }
    if (!opts.keepOpen) next.delete('open');
    setSp(next, { replace: true });
  };
  const [search, setSearch] = useState(query.q ?? '');
  const debounced = useDebounced(search, 250);
  useEffect(() => { if ((debounced || null) !== (query.q ?? null)) patch({ q: debounced.trim() || null }, { keepOpen: true }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [debounced]);
  useEffect(() => { setSearch(query.q ?? ''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [query.q]);

  const data = q.data;
  const filtered = FILTER_KEYS.some((k) => sp.get(k));
  const clear = () => { const n = new URLSearchParams(sp); for (const k of FILTER_KEYS) n.delete(k); setSp(n, { replace: true }); };

  const toggleMonitor = async () => {
    if (!data) return;
    setBusy(true);
    try {
      await ds.setBamsMonitor(data.monitor.state !== 'running');
      bump();
    } catch (e) { toast.push({ kind: 'error', message: 'Could not change the monitor.', detail: errText(e) }); }
    finally { setBusy(false); }
  };

  const cols: Column<BamsRow>[] = [
    { key: 'appliance', header: 'Appliance', sort: () => 0, className: 'bm-c-wide', cell: (r) => <span className="bm-appl"><span className="bm-appl__client truncate" title={r.object.client_name}>{r.object.client_name}</span><span className="subtle">/</span><span className="mono">{r.object.name}</span>{r.simulated && <SimulatedBadge />}</span> },
    { key: 'location', header: 'Location', sort: () => 0, className: 'bm-c-loc', cell: (r) => r.object.location ?? <span className="subtle">-</span> },
    { key: 'metric', header: 'Metric', sort: () => 0, primary: true, className: 'bm-c-metric', cell: (r) => r.metric_name },
    { key: 'current', header: 'Current', sort: () => 0, align: 'right', cell: (r) => <Value value={r.current_value} /> },
    { key: 'trend', header: 'Trend', cell: (r) => <Spark points={r.spark ?? []} tone={r.display_status === 'open' ? 'danger' : undefined} /> },
    { key: 'high30', header: '30D high', sort: () => 0, align: 'right', className: 'muted', cell: (r) => <High v={r.highs.d30.value} /> },
    { key: 'high60', header: '60D high', sort: () => 0, align: 'right', className: 'muted', cell: (r) => <High v={r.highs.d60.value} /> },
    { key: 'high90', header: '90D high', sort: () => 0, align: 'right', className: 'muted', cell: (r) => <High v={r.highs.d90.value} /> },
    { key: 'last_update', header: 'Last update', sort: () => 0, className: 'muted', cell: (r) => <span className="num">{formatAge(r.age_seconds)}</span> },
    { key: 'status', header: 'Status', sort: () => 0, className: 'bm-c-wide', cell: (r) => <RowStatus row={r} /> },
  ];
  const sort = { key: query.sort ?? 'status', dir: query.dir ?? 'asc' } as const;

  const rows = data?.rows ?? [];
  const byAccount = useMemo(() => {
    const m = new Map<string, BamsRow[]>();
    for (const r of rows) { const l = m.get(r.object.client_id); if (l) l.push(r); else m.set(r.object.client_id, [r]); }
    return m;
  }, [rows]);
  const active = !!(query.view && query.view !== 'all') || filtered;
  const isOpen = (id: string) => (active ? !collapsedWhileFiltered.has(id) : id in manual ? manual[id] : hasActiveAlert(byAccount.get(id) ?? []));
  const setOpen = (id: string, open: boolean) => {
    if (active) setCollapsedWhileFiltered((c) => { const n = new Set(c); if (open) n.delete(id); else n.add(id); return n; });
    else setManual((m) => { const n = { ...m, [id]: open }; saveGroupState(n); return n; });
  };
  const toggleAll = () => {
    const ids = [...byAccount.keys()];
    const allOpen = ids.every(isOpen);
    if (active) setCollapsedWhileFiltered(allOpen ? new Set(ids) : new Set());
    else setManual((m) => { const n = { ...m, ...Object.fromEntries(ids.map((i) => [i, !allOpen])) }; saveGroupState(n); return n; });
  };
  const grouping = {
    groupKey: (r: BamsRow) => r.object.client_id,
    groupName: (_k: string, g: BamsRow[]) => g[0].object.client_name,
    summary: (_k: string, g: BamsRow[]) => groupSummary(g),
    isOpen, onToggle: (k: string) => setOpen(k, !isOpen(k)), onToggleAll: toggleAll, noun: 'accounts',
  };

  const accountOpts: SelectOption[] = data ? data.filters.accounts.map((a) => ({ value: a.id, label: a.name })) : [];
  if (query.account && query.account.includes(',')) accountOpts.push({ value: query.account, label: `${query.account.split(',').length} accounts` });

  return (
    <div className="page bm-page">
      <PageHeader
        title="BAMS"
        meta={<span className="bm-meta">Infrastructure health {data?.provider.simulated && <SimulatedBadge />} {data && <span className="num">{data.summary.total} metrics on {data.filters.objects.length} appliances</span>}</span>}
        actions={
          <>
            <Link to="/bams/import" className="btn btn--secondary btn--md"><span className="btn__icon"><Upload size={16} strokeWidth={1.5} aria-hidden="true" /></span><span className="btn__label">Import appliances</span></Link>
            <Button variant="primary" icon={<Plus size={16} strokeWidth={1.5} />} onClick={() => setDialog({})}>Add appliance</Button>
          </>
        }
      />
      {q.loading && <SkeletonRows rows={8} label="Loading BAMS" />}
      {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not load BAMS" /> : null}
      {q.stale && <StaleDataBanner since={q.lastOk ? formatTime(q.lastOk.toISOString(), settings.time_display, true) : 'earlier'} onRetry={q.reload} />}
      {data && (
        <>
          <MonitorStrip data={data} busy={busy} onToggle={toggleMonitor} tz={settings.time_display} />
          {data.banner && (
            <div role="alert" className="banner banner--danger">
              <ShieldAlert size={16} strokeWidth={1.5} aria-hidden="true" />
              <div className="banner__body">
                <b>BAMS provider unavailable.</b> {data.banner.text} Every metric shows No data and alert evaluation is frozen.{data.provider.mode === 'PROD' && ' No values are simulated in PROD.'}
                <div className="muted sm">Monitor state: {data.monitor.state}{data.provider.available ? '' : ' · Start is disabled until a provider is connected.'}</div>
              </div>
            </div>
          )}
          <div className="bm-strip" role="group" aria-label="Summary">
            <Kpi label="Active alerts" value={data.summary.active_alerts} tone={data.summary.active_alerts ? 'danger' : undefined}
              sub={data.banner ? 'none evaluated' : `${data.summary.open} open · ${data.summary.recovered} recovered, awaiting close`} />
            <Kpi label="Delayed / Stale" value={data.summary.delayed_stale} tone={data.summary.delayed_stale ? 'warning' : undefined}
              sub={data.banner ? 'n/a' : `${data.summary.delayed} delayed · ${data.summary.stale} stale`} />
            <Kpi label="Live" value={data.summary.live} tone={data.summary.live ? 'success' : undefined} sub={`updated within ${data.monitor.freshness.live_seconds} s`} />
            <Kpi label="No data" value={data.summary.no_data} sub="no value received yet" />
          </div>
          <div className="bm-bar">
            <TabStrip label="Quick views" value={query.view ?? 'all'} onChange={(v) => patch({ view: v === 'all' ? null : v })} items={BAMS_VIEWS.map((v) => ({ id: v, label: VIEW_LABEL[v], count: data.view_counts[v] }))} />
            <div className="bm-bar__spacer" />
            <Link to="/bams/alerts" className="btn btn--secondary btn--sm"><span className="btn__icon"><Bell size={14} strokeWidth={1.5} aria-hidden="true" /></span><span className="btn__label">Alerts</span></Link>
            <Link to="/bams/config" className="btn btn--secondary btn--sm"><span className="btn__icon"><SettingsIcon size={14} strokeWidth={1.5} aria-hidden="true" /></span><span className="btn__label">Alert configuration</span></Link>
          </div>
          <div className="bm-bar bm-filters">
            <label className="bm-search">
              <Search size={14} strokeWidth={1.5} aria-hidden="true" />
              <input className="bm-search__input" type="search" aria-label="Search appliance or metric" placeholder="Search appliance or metric" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <FilterSelect label="Account" value={query.account ?? null} options={accountOpts} onChange={(v) => patch({ account: v, object_id: null })} />
            <FilterSelect label="Location" value={query.location ?? null} options={data.filters.locations.map((l) => ({ value: l, label: l }))} onChange={(v) => patch({ location: v })} />
            <FilterSelect label="Appliance" value={query.object_id ?? null} options={data.filters.objects.filter((o) => !query.account || query.account.split(',').includes(o.client_id)).map((o) => ({ value: o.id, label: `${o.name} (${o.client_name})` }))} onChange={(v) => patch({ object_id: v })} />
            <FilterSelect label="Metric" value={query.metric ?? null} options={data.filters.metrics.map((m) => ({ value: m, label: m }))} onChange={(v) => patch({ metric: v })} />
            <FilterSelect label="Status" value={query.status ?? null} options={STATUS_OPTIONS} onChange={(v) => patch({ status: v })} />
            {filtered && <Button size="sm" variant="ghost" onClick={clear}>Clear filters</Button>}
          </div>
          {data.summary.total === 0 && !filtered ? (
            <Panel>
              <div className="bm-empty">
                <h3>No appliances to monitor</h3>
                <p className="muted">Add an appliance and its Bloomberg tickers, or import many at once from a spreadsheet. Nothing is shown until you add one.</p>
                <div className="bm-empty__actions">
                  <Button variant="primary" size="sm" icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => setDialog({})}>Add appliance</Button>
                  <Link to="/bams/import" className="btn btn--secondary btn--sm"><span className="btn__icon"><Upload size={14} strokeWidth={1.5} aria-hidden="true" /></span><span className="btn__label">Import appliances</span></Link>
                </div>
              </div>
            </Panel>
          ) : data.rows.length === 0 ? (
            <Panel>
              <div className="bm-empty">
                <h3>No metrics match these filters</h3>
                <p className="muted">{describeFilters(query)} matches 0 of {data.counts.unfiltered} metrics.</p>
                <Button size="sm" onClick={clear}>Clear filters</Button>
              </div>
            </Panel>
          ) : (
            <Panel bodyClassName="bm-tablebody">
              <DataTable
                className="bm-tbl"
                caption="Monitored metrics"
                columns={cols}
                rows={data.rows}
                grouping={grouping}
                rowKey={(r) => r.id}
                onRowOpen={(r) => patch({ open: r.id }, { keepOpen: true })}
                rowClassName={(r) => cx(r.display_status === 'open' && 'bm-row--open', r.display_status === 'recovered' && 'bm-row--recovered', r.id === openId && 'is-highlight')}
                sort={sort}
                onSortChange={(s) => patch(s ? { sort: s.key === 'status' && s.dir === 'asc' ? null : s.key, dir: s.dir === 'desc' ? 'desc' : null } : { sort: null, dir: null })}
              />
            </Panel>
          )}
          <p className="muted sm bm-foot">
            {data.counts.rows} of {data.counts.unfiltered} metrics. Status shows the worst of alert state and freshness, as a word and an icon. Live is {data.monitor.freshness.live_seconds} s or less at the current {data.monitor.poll_interval_seconds} s poll. Values are percentages.
          </p>
        </>
      )}
      {openId && <MetricDrawer id={openId} onClose={() => patch({ open: null }, {})} onEdit={(objectId) => setDialog({ objectId })} />}
      {dialog && <ApplianceDialog objectId={dialog.objectId} defaultClientId={query.account && !query.account.includes(',') ? query.account : undefined} onClose={() => setDialog(null)} onDeleted={() => { setDialog(null); patch({ open: null }); }} />}
    </div>
  );
}

const High = ({ v }: { v: number | null }) => (v == null ? <span className="subtle">-</span> : <>{v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</>);

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | null; options: SelectOption[]; onChange: (v: string | null) => void }) {
  return (
    <div className="bm-filter">
      <span className="label" aria-hidden="true">{label}</span>
      <Select size="sm" aria-label={label} value={value} options={options} onChange={onChange} clearable clearLabel={`All ${label.toLowerCase()}`} placeholder="All" />
    </div>
  );
}

function describeFilters(q: BamsStateQuery): string {
  const parts: string[] = [];
  if (q.status) parts.push(`Status ${STATUS_OPTIONS.find((o) => o.value === q.status)?.label}`);
  if (q.location) parts.push(`Location ${q.location}`);
  if (q.metric) parts.push(`Metric ${q.metric}`);
  if (q.account) parts.push('Account filter');
  if (q.object_id) parts.push('Appliance filter');
  if (q.q) parts.push(`search "${q.q}"`);
  return parts.join(', ') || 'These filters';
}

function MonitorStrip({ data, busy, onToggle, tz }: { data: BamsState; busy: boolean; onToggle: () => void; tz: 'local' | 'gmt' }) {
  const m = data.monitor;
  const running = m.state === 'running';
  const label = m.state === 'running' ? 'Running' : m.state === 'stopped' ? 'Stopped' : 'Provider unavailable';
  return (
    <div className="panel bm-monitor">
      <div className="bm-monitor__row">
        <span className={cx('badge', running ? 'badge--success' : m.state === 'provider_unavailable' ? 'badge--danger' : 'badge--neutral')}>Monitor {label}</span>
        <span className="muted sm">Provider <b className="text-strong">{data.provider.simulated ? 'Simulated (DEV)' : data.provider.available ? `Bloomberg (${data.provider.mode})` : `Unavailable (${data.provider.mode})`}</b></span>
        <span className="muted sm">Poll every <b className="num text-strong">{formatSeconds(m.poll_interval_seconds)}</b></span>
        <Tooltip text={`Live means updated within ${m.freshness.live_seconds} s; Stale after ${m.freshness.stale_seconds_default} s by default.`}>
          <span className="muted sm" tabIndex={0}>Last poll <span className="num">{formatTime(m.last_poll_at, tz, true)}</span> · Next <span className="num">{m.next_poll_at ? formatTime(m.next_poll_at, tz, true) : 'n/a'}</span></span>
        </Tooltip>
        <div className="bm-bar__spacer" />
        <Button size="sm" busy={busy} busyLabel="Working…" disabled={!data.provider.available && !running} aria-disabled={!data.provider.available && !running} onClick={onToggle}
          icon={running ? <Square size={14} strokeWidth={1.5} /> : <Play size={14} strokeWidth={1.5} />}>{running ? 'Stop monitor' : 'Start monitor'}</Button>
        <Link to="/bams/settings" className="btn btn--secondary btn--sm"><span className="btn__icon"><SettingsIcon size={14} strokeWidth={1.5} aria-hidden="true" /></span><span className="btn__label">Settings</span></Link>
      </div>
    </div>
  );
}

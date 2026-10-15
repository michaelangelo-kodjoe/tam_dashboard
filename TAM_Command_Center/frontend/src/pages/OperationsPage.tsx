import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { PageHeader } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { EmptyState, ErrorBanner, SkeletonRows } from '../components/ui/Feedback';
import { useToast } from '../components/ui/Toast';
import { DataSourceError } from '../data/DataSource';
import { useData, useQuery } from '../store/DataContext';
import { useDebounced, useDocumentTitle } from '../lib/hooks';
import { MAX_SELECT, allIds, filtersActive, groupIds, isExpanded, summaryText, toggleGroup } from '../lib/operations';
import { OPS_STATUSES, type OpsQuarterName, type OpsQuery, type OpsRow } from '../opsTypes';
import { OpsTable } from './operations/OpsTable';
import { QuarterDialog } from './operations/QuarterDialog';
import { SetVersionDialog } from './operations/SetVersionDialog';
import { ApplianceEditDialog } from './operations/ApplianceEditDialog';
import '../styles/operations.css';

const STATUS_OPTS = OPS_STATUSES.map((s) => ({ value: s, label: s }));
const ENV_OPTS = [{ value: 'PROD', label: 'PROD' }, { value: 'DEV', label: 'DEV' }, { value: 'unset', label: 'Environment not set' }];
const POL_OPTS = [{ value: 'East', label: 'East' }, { value: 'West', label: 'West' }, { value: 'unset', label: 'Not set' }];

export function parseQuarterParam(v: string | null): { year: number; quarter: OpsQuarterName } | null {
  const m = /^(\d{4})-(Q[1-4])$/.exec(v ?? '');
  return m ? { year: Number(m[1]), quarter: m[2] as OpsQuarterName } : null;
}

export function OperationsPage() {
  useDocumentTitle('Operations');
  const { ds, bump } = useData();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const qp = parseQuarterParam(params.get('quarter'));
  const status = params.get('status');
  const env = params.get('env');
  const pol = params.get('pol');
  const qParam = params.get('q') ?? '';
  const applianceParam = params.get('appliance');

  const [qText, setQText] = useState(qParam);
  const debounced = useDebounced(qText, 250);
  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  useEffect(() => { if ((debounced.trim() || null) !== (qParam || null)) set({ q: debounced.trim() || null }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [debounced]);

  const query: OpsQuery = { ...(qp ?? {}), q: qParam || undefined, status: status ?? undefined, environment: (env as OpsQuery['environment']) ?? undefined, polarity: (pol as OpsQuery['polarity']) ?? undefined };
  const key = `operations:${JSON.stringify(query)}`;
  const res = useQuery(key, (d) => d.getOperations(query));
  const data = res.data;
  const sel = data?.selected ?? null;
  const active = filtersActive({ q: qParam, status, environment: env, polarity: pol });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [quarterDlg, setQuarterDlg] = useState<'add' | 'edit' | null>(null);
  const [versionDlg, setVersionDlg] = useState(false);

  // selection resets on quarter change; only appliances still shown stay selected
  const quarterKey = sel ? `${sel.year}-${sel.quarter}` : '';
  const lastQuarter = useRef(quarterKey);
  useEffect(() => {
    if (lastQuarter.current !== quarterKey) { lastQuarter.current = quarterKey; setSelected(new Set()); setSelecting(false); return; }
    if (!data) return;
    const visible = new Set(allIds(data.groups));
    setSelected((s) => (s.size && [...s].some((i) => !visible.has(i)) ? new Set([...s].filter((i) => visible.has(i))) : s));
  }, [data, quarterKey]);

  const isOpen = (id: string) => isExpanded(id, expanded, collapsed, active);
  const toggleOpen = (id: string) => {
    const flip = (s: Set<string>) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };
    if (active) setCollapsed(flip); else setExpanded(flip);
  };
  const groups = data?.groups ?? [];
  const expandAll = () => { setExpanded(new Set(groups.map((g) => g.client_id))); setCollapsed(new Set()); };
  const collapseAll = () => { setExpanded(new Set()); setCollapsed(new Set(groups.map((g) => g.client_id))); };

  const allOpen = groups.length > 0 && groups.every((g) => isOpen(g.client_id));
  const toggleAll = () => (allOpen ? collapseAll() : expandAll());
  const leaveSelecting = () => { setSelecting(false); setSelected(new Set()); };
  const everyId = useMemo(() => allIds(groups), [groups]);
  const selectAll = () => {
    if (everyId.length > MAX_SELECT) toast.push({ kind: 'info', message: `Selection is capped at ${MAX_SELECT} appliances per action.` });
    setSelected(new Set(everyId.slice(0, MAX_SELECT)));
  };
  const rowToggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const groupToggle = (g: (typeof groups)[number]) => setSelected((s) => toggleGroup(groupIds(g), s));

  const changeStatus = async (r: OpsRow, st: string) => {
    if (!sel) return;
    try {
      await ds.saveOperationsAppliance({ object_id: r.object_id, year: sel.year, quarter: sel.quarter, status: st as OpsRow['status'], ...(r.record_row_version !== null ? { expected_row_version: r.record_row_version } : {}) });
      toast.push({ kind: 'success', message: `${r.appliance}: ${st}` });
    } catch (e) {
      toast.push({ kind: 'error', message: e instanceof DataSourceError ? e.message : 'Could not change the status. Nothing was changed.' });
    }
    bump();
  };

  const editRow = applianceParam ? groups.flatMap((g) => g.rows).find((r) => r.object_id === applianceParam) ?? null : null;
  const reset = () => { setQText(''); set({ q: null, status: null, env: null, pol: null }); };
  const quarterOpts = (data?.quarters ?? []).map((q) => ({ value: `${q.year}-${q.quarter}`, label: q.label }));

  let body;
  if (res.error && !data) body = <ErrorBanner error={res.error} onRetry={res.reload} />;
  else if (!data) body = <SkeletonRows rows={8} label="Loading operations" />;
  else if (data.empty === 'no_quarters') {
    body = <EmptyState action={<Button variant="primary" icon={<Plus size={16} strokeWidth={1.5} />} onClick={() => setQuarterDlg('add')}>Add your first quarter</Button>}>No quarters yet. Add the quarter you are upgrading in to see every appliance with its date, version and status.</EmptyState>;
  } else if (data.empty === 'no_appliances') {
    body = <EmptyState action={<Link to="/bams/import" className="btn btn--primary btn--md"><span className="btn__label">Import appliances in BAMS</span></Link>}>No appliances yet. Operations lists every BAMS appliance.</EmptyState>;
  } else if (groups.length === 0) {
    body = <EmptyState action={<Button size="sm" onClick={reset}>Reset filters</Button>}>No appliances match these filters.</EmptyState>;
  } else {
    body = <OpsTable groups={groups} selecting={selecting} allOpen={allOpen} onToggleAll={toggleAll} selected={selected} isOpen={isOpen} onToggleOpen={toggleOpen} onToggleGroup={groupToggle} onToggleRow={rowToggle} onStatus={changeStatus} onEdit={(r) => set({ appliance: r.object_id })} />;
  }

  return (
    <div className="page ops">
      <PageHeader title="Operations" meta="Appliance upgrades by quarter">
        {data && data.empty !== 'no_quarters' && sel && (
          <>
            <div className="ops-qrow">
              <Select size="sm" value={`${sel.year}-${sel.quarter}`} onChange={(v) => v && set({ quarter: v })} options={quarterOpts} aria-label="Quarter" className="ops-quarter" />
              <Button size="sm" variant="ghost" onClick={() => setQuarterDlg('edit')}>Edit quarter</Button>
              <Button size="sm" variant="secondary" icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => setQuarterDlg('add')}>Add quarter</Button>
            </div>
            <div className="ops-chips" aria-label="Quarter dates">
              <span className="ops-chip">DEV <b className="num">{sel.dev_date ?? 'Not set'}</b></span>
              <span className="ops-chip">PROD East <b className="num">{sel.east_prod_date ?? 'Not set'}</b></span>
              <span className="ops-chip">PROD West <b className="num">{sel.west_prod_date ?? 'Not set'}</b></span>
            </div>
          </>
        )}
      </PageHeader>

      {data && !data.empty && (
        <>
          <p className="ops-sum" aria-live="polite">
            {active ? `${data.summary.total} of ${data.appliance_total} appliances match` + (data.summary.total ? summaryText(data.summary.total, data.summary).replace(/^\d+ appliances?/, '') : '') : summaryText(data.summary.total, data.summary)}
          </p>
          <div className="filterbar" role="search" aria-label="Operations filters">
            <div className="filterbar__item filterbar__item--search">
              <Search size={16} strokeWidth={1.5} className="filterbar__icon" aria-hidden="true" />
              <input type="search" className="input input--sm filterbar__search" placeholder="Search account or appliance" aria-label="Search account or appliance" value={qText} onChange={(e) => setQText(e.target.value)} />
            </div>
            <Select size="sm" value={status} onChange={(v) => set({ status: v })} options={STATUS_OPTS} clearable clearLabel="All statuses" placeholder="All statuses" aria-label="Status filter" />
            <Select size="sm" value={env} onChange={(v) => set({ env: v })} options={ENV_OPTS} clearable clearLabel="All environments" placeholder="All environments" aria-label="Environment filter" />
            <Select size="sm" value={pol} onChange={(v) => set({ pol: v })} options={POL_OPTS} clearable clearLabel="All polarity" placeholder="All polarity" aria-label="Polarity filter" />
            <Button size="sm" variant="ghost" onClick={reset} disabled={!active}>Reset</Button>
          </div>
          <div className="ops-tools">
            <Button size="sm" variant={selecting ? 'primary' : 'secondary'} aria-pressed={selecting} onClick={() => (selecting ? leaveSelecting() : setSelecting(true))} disabled={!groups.length && !selecting}>{selecting ? 'Done selecting' : 'Select'}</Button>
            <span className="ops-spacer" />
            {selecting && <Button size="sm" variant="ghost" onClick={selectAll} disabled={!everyId.length}>Select all ({everyId.length})</Button>}
          </div>
          {selecting && selected.size > 0 && (
            <div className="ops-selbar" role="region" aria-label="Selection">
              <b className="num">{selected.size} selected</b>
              <span className="ops-div" aria-hidden="true" />
              <Button size="sm" variant="secondary" onClick={() => setVersionDlg(true)}>Set version</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}
        </>
      )}
      {body}

      {quarterDlg && data && (
        <QuarterDialog
          quarter={quarterDlg === 'edit' ? sel : null} today={data.today} onClose={() => setQuarterDlg(null)}
          onSaved={(q) => { setQuarterDlg(null); set({ quarter: `${q.year}-${q.quarter}` }); }}
          onDeleted={() => { setQuarterDlg(null); set({ quarter: null }); }}
        />
      )}
      {versionDlg && sel && <SetVersionDialog quarter={sel} ids={[...selected]} onClose={() => setVersionDlg(false)} onDone={() => { setVersionDlg(false); setSelected(new Set()); }} />}
      {editRow && sel && data && <ApplianceEditDialog key={editRow.object_id + editRow.object_row_version + (editRow.record_row_version ?? 0)} row={editRow} quarter={sel} today={data.today} onClose={() => set({ appliance: null })} />}
    </div>
  );
}

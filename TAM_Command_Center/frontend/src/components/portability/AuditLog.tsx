import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../ui/Button';
import { Select, type SelectOption } from '../ui/Select';
import { EmptyState, ErrorBanner, SkeletonRows } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useApp, useData, useQuery } from '../../store/DataContext';
import { useDebounced } from '../../lib/hooks';
import { formatTimestamp } from '../../lib/dates';
import { saveFile } from '../../lib/download';
import type { AuditEvent, AuditQuery } from '../../types';

const PAGE = 50;
const opts = (a: string[] | undefined): SelectOption[] => (a ?? []).map((v) => ({ value: v, label: v }));

function Values({ title, v }: { title: string; v: Record<string, unknown> | null }) {
  if (!v) return <div><h4 className="label">{title}</h4><p className="subtle">-</p></div>;
  return (
    <div>
      <h4 className="label">{title}</h4>
      <dl className="au-kv">
        {Object.entries(v).map(([k, val]) => <div key={k}><dt className="muted">{k}</dt><dd>{val == null || val === '' ? <span className="subtle">-</span> : typeof val === 'object' ? JSON.stringify(val) : String(val)}</dd></div>)}
      </dl>
    </div>
  );
}

/** Read-only audit log (Settings > Audit log, contract 18.2). Loaded only when its section is opened. */
export function AuditLog() {
  const { ds } = useData();
  const { accounts, today } = useApp();
  const toast = useToast();
  const facets = useQuery('audit-facets', (d) => d.getAuditFacets());
  const [f, setF] = useState<{ category: string | null; object_type: string | null; action: string | null; source: string | null; client_id: string | null; from: string; to: string }>({ category: null, object_type: null, action: null, source: null, client_id: null, from: '', to: '' });
  const [text, setText] = useState('');
  const q = useDebounced(text, 300);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query: AuditQuery = useMemo(() => ({
    category: f.category ?? undefined, object_type: f.object_type ?? undefined, action: f.action ?? undefined, source: f.source ?? undefined, client_id: f.client_id ?? undefined,
    from: f.from || undefined, to: f.to || undefined, q: q.trim() || undefined,
  }), [f, q]);
  useEffect(() => { setOffset(0); setOpen(null); }, [query]);
  const page = useQuery(`audit:${JSON.stringify(query)}:${offset}`, (d) => d.getAudit({ ...query, limit: PAGE, offset }));
  const d = page.data;
  const ret = d?.retention ?? facets.data?.retention ?? null;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const active = Object.values(f).some(Boolean) || !!q.trim();
  const reset = () => { setF({ category: null, object_type: null, action: null, source: null, client_id: null, from: '', to: '' }); setText(''); };

  const download = async () => {
    setBusy('csv');
    try { saveFile(await ds.exportAudit(query)); toast.push({ kind: 'success', message: 'Audit CSV downloaded' }); }
    catch (e) { toast.push({ kind: 'error', message: e instanceof DataSourceError && e.code === 'payload_too_large' ? e.message || 'Too many rows. Narrow the filters.' : 'Could not export the audit log.', detail: e instanceof Error && !(e instanceof DataSourceError && e.code === 'payload_too_large') ? e.message : undefined }); }
    finally { setBusy(null); }
  };

  const first = d && d.total ? d.offset + 1 : 0;
  const last = d ? d.offset + d.items.length : 0;
  return (
    <div className="au">
      <div className="au-filters" role="search" aria-label="Audit filters">
        <input type="search" className="input input--sm au-search" placeholder="Search object, reason, action, account" aria-label="Search audit log" value={text} onChange={(e) => setText(e.target.value)} />
        <Select size="sm" aria-label="Category filter" value={f.category} onChange={(v) => set('category', v)} options={opts(facets.data?.categories)} clearable clearLabel="All categories" placeholder="All categories" />
        <Select size="sm" aria-label="Object type filter" value={f.object_type} onChange={(v) => set('object_type', v)} options={opts(facets.data?.object_types)} clearable clearLabel="All objects" placeholder="All objects" />
        <Select size="sm" aria-label="Action filter" value={f.action} onChange={(v) => set('action', v)} options={opts(facets.data?.actions)} clearable clearLabel="All actions" placeholder="All actions" />
        <Select size="sm" aria-label="Source filter" value={f.source} onChange={(v) => set('source', v)} options={opts(facets.data?.sources)} clearable clearLabel="All sources" placeholder="All sources" />
        <Select size="sm" aria-label="Account filter" value={f.client_id} onChange={(v) => set('client_id', v)} options={accounts.map((a) => ({ value: a.id, label: a.name }))} clearable clearLabel="All accounts" placeholder="All accounts" />
        <label className="au-date"><span className="label">From</span><input type="date" className="input input--sm" aria-label="From date" value={f.from} max={f.to || today} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="au-date"><span className="label">To</span><input type="date" className="input input--sm" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set('to', e.target.value)} /></label>
        {active && <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>}
        <span className="pt-spacer" />
        <Button size="sm" icon={<Download size={14} strokeWidth={1.5} />} busy={busy === 'csv'} busyLabel="Preparing…" onClick={() => void download()}>Download CSV</Button>
      </div>
      {ret && <p className="muted sm au-retention">Entries older than {ret.retention_days} days are removed every {ret.interval_days / 7} weeks. Last cleaned: {ret.last_pruned_at ? formatTimestamp(ret.last_pruned_at) : 'Never'}.{ret.next_due_at ? ` Next: ${formatTimestamp(ret.next_due_at)}` : ''}</p>}
      {page.loading && <SkeletonRows rows={6} label="Loading audit log" />}
      {page.error ? <ErrorBanner error={page.error} onRetry={page.reload} title="Could not load the audit log" /> : null}
      {d && d.items.length === 0 && <EmptyState action={active ? <Button size="sm" onClick={reset}>Reset filters</Button> : undefined}>{active ? 'No audit events match these filters.' : 'No audit events yet.'}</EmptyState>}
      {d && d.items.length > 0 && (
        <div className="panel table-scroll">
          <table className="table table--compact au-table">
            <caption className="sr-only">Audit log, newest first</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Account</th><th scope="col">Category</th><th scope="col">Object</th><th scope="col">Action</th><th scope="col">Source</th><th scope="col">Summary</th></tr></thead>
            <tbody>
              {d.items.map((e) => <AuditRow key={e.id} e={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />)}
            </tbody>
          </table>
        </div>
      )}
      {d && (
        <div className="au-pager">
          <span className="muted sm num" aria-live="polite">{d.total === 0 ? '0 events' : `${first}-${last} of ${d.total}`}</span>
          <span className="pt-spacer" />
          <Button size="sm" disabled={offset === 0 || page.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
          <Button size="sm" disabled={!d.has_more || page.loading} onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      )}
    </div>
  );
}

function AuditRow({ e, open, onToggle }: { e: AuditEvent; open: boolean; onToggle: () => void }) {
  const { settings } = useApp();
  return (
    <>
      <tr className="is-clickable au-row" onClick={onToggle}>
        <td className="num"><button type="button" className="row-link au-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for event ${e.id}`} onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>{formatTimestamp(e.timestamp, settings.time_display)}</button></td>
        <td>{e.client_name ?? <span className="subtle">-</span>}</td>
        <td>{e.category}</td>
        <td><span className="muted">{e.object_type}</span> {e.object_label}</td>
        <td>{e.action}</td>
        <td>{e.source}</td>
        <td>{e.summary}</td>
      </tr>
      {open && (
        <tr className="au-detail"><td colSpan={7}>
          <div className="au-detail__grid">
            <div><h4 className="label">Reason</h4><p>{e.reason ?? <span className="subtle">None</span>}</p></div>
            <Values title="Before" v={e.old_value} />
            <Values title="After" v={e.new_value} />
          </div>
        </td></tr>
      )}
    </>
  );
}

import { useEffect, useRef } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../ui/Button';
import type { ImportFormat, ImportResult } from '../../types';

function mb(n: number) { return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="imp-tile">
      <span className="label">{label}</span>
      <span className={`imp-tile__n num ${value === 0 ? 'subtle' : ''}`}>{value}</span>
      <span className="muted sm">{sub}</span>
    </div>
  );
}

export function StepResult({ r, onDownload, busy, error }: { r: ImportResult; onDownload: (f: ImportFormat) => void; busy: boolean; error: string | null }) {
  const c = r.counts;
  const bd = r.breakdown;
  const n = (k: string) => bd[k] ?? 0;
  const when = new Date(r.applied_at);
  const fmt: ImportFormat = r.file.format ?? 'xlsx';
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => head.current?.focus(), []);
  const nothing = c.created === 0 && c.updated === 0;
  return (
    <div className="imp-result">
      <h3 ref={head} tabIndex={-1} className="imp-h">{nothing ? 'Import applied: nothing needed to change' : 'Import applied'}</h3>
      <p className="muted">{Number.isNaN(when.getTime()) ? '' : `${when.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · `}{r.file.name} · {r.file.rows_found} rows</p>
      <div className="imp-tiles imp-tiles--5" role="group" aria-label="Result counts">
        <Tile label="Created" value={c.created} sub={`${n('created_new')} new + ${n('created_marked_different')} marked Different`} />
        <Tile label="Updated" value={c.updated} sub={n('updated_exact') + n('updated_marked_same') === c.updated ? `${n('updated_exact')} exact + ${n('updated_marked_same')} marked Same` : `from ${n('updated_exact') + n('updated_marked_same')} rows`} />
        <Tile label="Unchanged" value={c.unchanged} sub="matched, nothing to fill" />
        <Tile label="Skipped" value={c.skipped} sub={`${n('skipped_invalid')} invalid + ${n('skipped_by_user')} marked Skip`} />
        <Tile label="Overwritten" value={c.overwritten} sub="fill blanks only" />
      </div>
      <dl className="imp-facts-list">
        <div><dt className="label">Safety backup</dt><dd>{r.backup ? <><span className="mono">{r.backup.name}</span> <span className="muted">· {mb(r.backup.size_bytes)} · taken before any change</span></> : <span className="muted">No backup was needed because nothing changed.</span>}</dd></div>
        <div><dt className="label">Transaction</dt><dd>All changes written together. If any step had failed, none would have been saved.</dd></div>
        <div><dt className="label">Audit trail</dt><dd><span className="num">{r.audit_events}</span> {r.audit_events === 1 ? 'event' : 'events'} recorded with source <b>Bulk Import</b>.</dd></div>
        <div><dt className="label">Blanks filled</dt><dd><span className="num">{r.fields_filled}</span> {r.fields_filled === 1 ? 'field' : 'fields'} on <span className="num">{c.updated}</span> existing {c.updated === 1 ? 'account' : 'accounts'}. Nothing replaced.</dd></div>
      </dl>
      {r.skipped.length > 0 && (
        <div>
          <h4 className="label">Skipped rows</h4>
          <div className="table-scroll imp-tablewrap imp-tablewrap--short" tabIndex={0} role="region" aria-label="Skipped rows">
            <table className="table table--compact imp-table">
              <caption className="sr-only">Rows that were not imported</caption>
              <thead><tr><th scope="col">Row</th><th scope="col">Account name</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {r.skipped.map((s) => (
                  <tr key={s.row}><td className="num">{s.row}</td><td>{s.name ?? <span className="subtle">(empty)</span>}</td><td className="imp-detail">{s.kind === 'invalid' ? `Invalid: ${s.reason}` : s.reason}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="imp-btnrow imp-btnrow--top">
            <Button icon={<Download size={16} strokeWidth={1.5} />} onClick={() => onDownload(fmt)} busy={busy} busyLabel="Preparing…">Download skipped rows (.{fmt})</Button>
          </div>
          {error && <p role="alert" className="imp-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

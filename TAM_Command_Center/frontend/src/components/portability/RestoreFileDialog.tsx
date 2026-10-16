import { useCallback, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useData } from '../../store/DataContext';
import { saveFile } from '../../lib/download';
import { fmtBytes, TABLE_OPTIONS } from '../../lib/portability';
import type { RestoreFile, RestoreIssueQuery, RestorePlan, RestoreResult, PortTable } from '../../portTypes';
import { errText } from '../../pages/bams/common';

const STATE_TEXT: Record<RestoreFile['state'], { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'badge--success' }, unrecognized: { label: 'Unrecognized', cls: 'badge--warning' }, missing_columns: { label: 'Missing columns', cls: 'badge--danger' },
};
const OUTCOME_OPTS = [{ value: 'differs', label: 'Differs (skipped)' }, { value: 'invalid', label: 'Invalid (skipped)' }];

/** Restore from file (D-126..D-135): choose an Excel export or CSV files, preview per table, add the missing rows. Never overwrites. */
export function RestoreFileDialog({ onClose }: { onClose: () => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ table: string | null; outcome: string | null }>({ table: null, outcome: null });
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label); setError(null);
    try { return await fn(); } catch (e) {
      setError(errText(e));
      if (e instanceof DataSourceError && (e.code === 'preview_stale' || e.code === 'conflict') && plan) void ds.getRestorePlan(plan.restore_id).then(setPlan).catch(() => undefined);
      return null;
    } finally { setBusy(null); }
  }, [ds, plan]);

  const addFiles = async (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length) return;
    setBusy('Reading files'); setError(null);
    let cur = plan;
    try {
      for (const f of files) cur = await ds.inspectRestoreFile(f, cur ? { session: cur.restore_id } : {});
      setPlan(cur);
    } catch (e) {
      setError(`${errText(e)}${files.length > 1 ? ' Files before this one were added.' : ''}`);
      if (cur && cur !== plan) setPlan(cur);
    } finally { setBusy(null); if (input.current) input.current.value = ''; }
  };

  const refreshIssues = async (next: { table: string | null; outcome: string | null }) => {
    setFilter(next);
    if (!plan) return;
    const q: RestoreIssueQuery = { table: (next.table as PortTable) ?? undefined, outcome: (next.outcome as 'differs' | 'invalid') ?? undefined };
    const p = await run('Loading', () => ds.getRestorePlan(plan.restore_id, q));
    if (p) setPlan(p);
  };

  const remove = async (f: RestoreFile) => {
    if (!plan) return;
    const p = await run('Removing', () => ds.removeRestoreFile(plan.restore_id, f.file_id));
    if (p) setPlan(p.files.length ? p : null);
  };
  const setTable = async (f: RestoreFile, table: string | null) => {
    if (!plan || !table) return;
    const p = await run('Checking', () => ds.setRestoreTable(plan.restore_id, f.file_id, table));
    if (p) setPlan(p);
  };

  const apply = async () => {
    if (!plan) return;
    const r = await run('Restoring', () => ds.applyRestore({ restore_id: plan.restore_id, plan_hash: plan.plan_hash }));
    if (r) { setResult(r); bump(); toast.push({ kind: 'success', message: `Restore finished: ${r.counts.added} added` }); }
  };

  const download = async (format: 'xlsx' | 'csv') => {
    if (!result) return;
    const f = await run('Preparing', () => ds.downloadRestoreSkipped(result.restore_id, format));
    if (f) saveFile(f);
  };

  const hasTables = !!plan && plan.tables.some((t) => t.staged);
  const footer = result ? (
    <><span className="pt-spacer" /><Button variant="primary" onClick={onClose}>Done</Button></>
  ) : (
    <>
      {plan && <Button variant="ghost" onClick={() => { setPlan(null); setError(null); }} disabled={!!busy}>Start over</Button>}
      <span className="pt-spacer" />
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" busy={busy === 'Restoring'} busyLabel="Restoring…" disabled={!plan?.can_apply || !!busy} onClick={() => void apply()}>
        {plan?.nothing_to_restore ? 'Nothing to restore' : plan?.apply_label ?? 'Add missing rows'}
      </Button>
    </>
  );

  return (
    <Dialog title="Restore from file" width={920} onClose={onClose} footer={footer}>
      {result ? <ResultView r={result} busy={busy} onDownload={(f) => void download(f)} error={error} /> : (
        <div className="pt-restore">
          <div className="pt-what" role="note">
            <b>What happens</b>
            <ul>
              <li>A safety backup is taken first.</li>
              <li>Only rows that are missing from the app are added. Nothing existing is changed or deleted.</li>
              <li>Rows that differ from what is in the app are skipped and listed.</li>
            </ul>
          </div>
          <div
            className={`pt-drop${drag ? ' is-drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files); }}
          >
            <FileSpreadsheet size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>{plan ? 'Add another CSV file' : 'Choose one Excel export (.xlsx) or one or more CSV files (up to 9, 25 MiB each)'}</span>
            <input ref={input} id="restore-file-input" type="file" multiple accept=".xlsx,.csv" className="sr-only" aria-label="Choose files to restore" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
            <Button size="sm" icon={<Upload size={14} strokeWidth={1.5} />} disabled={!!busy || plan?.kind === 'xlsx'} onClick={() => input.current?.click()}>Choose files</Button>
          </div>
          {busy && busy !== 'Restoring' && <p className="muted sm" role="status">{busy}…</p>}
          {error && <p role="alert" className="field__error pt-err">{error}</p>}

          {plan && (
            <>
              <ul className="pt-files" aria-label="Files added">
                {plan.files.map((f) => (
                  <li key={f.file_id} className="pt-file">
                    <span className="pt-file__name truncate" title={f.name}>{f.name}</span>
                    <span className="muted sm num">{fmtBytes(f.size_bytes)}, {f.rows} rows</span>
                    {f.format === 'csv' ? (
                      <Select size="sm" value={f.table} onChange={(v) => void setTable(f, v)} options={TABLE_OPTIONS} placeholder="Choose a table" aria-label={`Table for ${f.name}`} disabled={!!busy} />
                    ) : <span className="muted sm pt-sheets" aria-label={`Sheets in ${f.name}`}>{f.sheets?.length ? f.sheets.map((x) => `${x.label} ${x.rows}`).join(', ') : 'All sheets in the workbook'}</span>}
                    <span className={`badge ${STATE_TEXT[f.state].cls}`}>{STATE_TEXT[f.state].label}</span>
                    <Button size="sm" variant="icon" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => void remove(f)} disabled={!!busy} icon={<X size={14} strokeWidth={1.5} />} />
                    {f.state === 'missing_columns' && <p className="field__error pt-file__msg">Missing: {f.missing_columns.join(', ')}</p>}
                  </li>
                ))}
              </ul>
              {plan.csv_notice && <div className="banner banner--info" role="note"><div className="banner__body sm">{plan.csv_notice}</div></div>}
              {plan.source && <p className="muted sm">Export from {plan.source.app} {plan.source.version}, {plan.source.channel}, {plan.source.exported_at.slice(0, 16).replace('T', ' ')}.</p>}
              {plan.warnings.map((w) => <div key={w.text} className="banner banner--info" role="status"><div className="banner__body sm">{w.text}</div></div>)}
              {plan.blocking.map((b) => <div key={b.text} className="banner banner--warning" role="alert"><div className="banner__body sm">{b.text}</div></div>)}
              {hasTables && (
                <div className="panel table-scroll">
                  <table className="table table--compact">
                    <caption className="sr-only">What the files contain, by table</caption>
                    <thead><tr><th scope="col">Table</th><th scope="col" className="is-right">New</th><th scope="col" className="is-right">Identical</th><th scope="col" className="is-right">Differs</th><th scope="col" className="is-right">Invalid</th></tr></thead>
                    <tbody>
                      {plan.tables.filter((t) => t.staged).map((t) => (
                        <tr key={t.key}>
                          <th scope="row">{t.label}</th>
                          <td className="is-right num">{t.new}</td><td className="is-right num">{t.identical}</td>
                          <td className={`is-right num${t.differs ? ' warning-text' : ''}`}>{t.differs}</td>
                          <td className={`is-right num${t.invalid ? ' danger-text' : ''}`}>{t.invalid}</td>
                        </tr>
                      ))}
                      <tr className="pt-total"><th scope="row">Total</th><td className="is-right num">{plan.totals.new}</td><td className="is-right num">{plan.totals.identical}</td><td className="is-right num">{plan.totals.differs}</td><td className="is-right num">{plan.totals.invalid}</td></tr>
                    </tbody>
                  </table>
                </div>
              )}
              {plan.nothing_to_restore && <p className="muted" role="status">Nothing to restore: everything in these files is already in the app.</p>}
              {(plan.issues_total > 0 || filter.table || filter.outcome) && (
                <section aria-label="Rows that will be skipped">
                  <div className="pt-issuehead">
                    <h3 className="label">Skipped rows <span className="num">({plan.issues_total})</span></h3>
                    <span className="pt-spacer" />
                    <Select size="sm" value={filter.outcome} onChange={(v) => void refreshIssues({ ...filter, outcome: v })} options={OUTCOME_OPTS} clearable clearLabel="All outcomes" placeholder="All outcomes" aria-label="Outcome filter" />
                    <Select size="sm" value={filter.table} onChange={(v) => void refreshIssues({ ...filter, table: v })} options={TABLE_OPTIONS.filter((t) => plan.tables.find((x) => x.key === t.value)?.staged)} clearable clearLabel="All tables" placeholder="All tables" aria-label="Table filter" />
                  </div>
                  <ul className="pt-issues">
                    {plan.issues.map((i) => (
                      <li key={`${i.file_id}-${i.row}-${i.column}`}><span className={`badge ${i.outcome === 'invalid' ? 'badge--danger' : 'badge--warning'}`}>{i.outcome === 'invalid' ? 'Invalid' : 'Differs'}</span> {i.text}</li>
                    ))}
                    {plan.issues_total > plan.issues.length && <li className="muted sm">Showing the first {plan.issues.length}. The skipped file lists every row after you apply.</li>}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The workbook (or each CSV) is named once, whatever shape the backend sends (per-sheet repeats or a single name). */
export function uniqueFiles(files: string[] | string | null | undefined): string[] {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  return [...new Set(list)];
}

function ResultView({ r, busy, onDownload, error }: { r: RestoreResult; busy: string | null; onDownload: (f: 'xlsx' | 'csv') => void; error: string | null }) {
  return (
    <div className="pt-result">
      <div role="status" className="banner pt-okbanner"><div className="banner__body"><b>{r.counts.added === 0 ? 'Nothing was added' : `Restore complete: ${r.counts.added} ${r.counts.added === 1 ? 'row' : 'rows'} added`}</b>
        <div className="muted sm">{uniqueFiles(r.files).join(', ')}</div></div></div>
      <div className="panel table-scroll">
        <table className="table table--compact">
          <caption className="sr-only">Result by table</caption>
          <thead><tr><th scope="col">Table</th><th scope="col" className="is-right">Added</th><th scope="col" className="is-right">Identical</th><th scope="col" className="is-right">Differs</th><th scope="col" className="is-right">Invalid</th></tr></thead>
          <tbody>{r.tables.map((t) => <tr key={t.key}><th scope="row">{t.label}</th><td className="is-right num">{t.added}</td><td className="is-right num">{t.identical}</td><td className="is-right num">{t.differs}</td><td className="is-right num">{t.invalid}</td></tr>)}</tbody>
        </table>
      </div>
      <dl className="rc-dl rc-dl--wide">
        <dt>Safety backup</dt><dd className="mono break">{r.backup ? r.backup.name : 'Not needed'}</dd>
        <dt>Skipped rows</dt><dd>{r.skipped_total === 0 ? 'None' : r.skipped_total}</dd>
      </dl>
      {error && <p role="alert" className="field__error">{error}</p>}
      {r.skipped_total > 0 && (
        <div className="pt-actions">
          <Button icon={<Download size={16} strokeWidth={1.5} />} disabled={!!busy} onClick={() => onDownload('xlsx')}>Download skipped rows (.xlsx)</Button>
          <Button icon={<Download size={16} strokeWidth={1.5} />} disabled={!!busy} onClick={() => onDownload('csv')}>Download skipped rows (.csv)</Button>
        </div>
      )}
    </div>
  );
}

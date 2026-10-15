import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Search, Upload } from 'lucide-react';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { cx } from '../../lib/cx';
import type { BamsCandidate, BamsChoice, BamsImportPlan, BamsImportResult, BamsReviewGroup, BamsRowState } from '../../bamsTypes';
import type { ImportFormat } from '../../types';
import { FILTERS, candidateDisabled, filterCount, groupRows, openBamsPath, type Decisions, type Filter, type MappedError } from './importState';
import { FreshnessBadge } from './BamsBits';
import { TabStrip } from './TabStrip';

const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const COLUMNS: { name: string; need: string; rules: string; example: string }[] = [
  { name: 'Account', need: 'Required*', rules: 'Exact account name. Use BPID instead if you have it.', example: 'Castellan Peak Global Markets' },
  { name: 'BPID', need: 'Required*', rules: '*At least one of Account or BPID. BPID is tried first.', example: '100482' },
  { name: 'Appliance', need: 'Required', rules: 'Appliance name, max 200. Repeat it on every row of that appliance.', example: 'SAPI-01' },
  { name: 'Metric', need: 'Required', rules: 'Metric name, max 200. One row per metric.', example: 'CPU utilisation %' },
  { name: 'Ticker', need: 'Required', rules: 'Bloomberg ticker, max 200. Must be unused anywhere.', example: 'BAMS.CPFX.SAPI01.CPU' },
  { name: 'Region', need: 'Optional', rules: 'Max 100.', example: 'Americas' },
  { name: 'Location', need: 'Optional', rules: 'Max 200.', example: 'Chicago' },
  { name: 'Environment', need: 'Optional', rules: 'PROD or DEV.', example: 'PROD' },
  { name: 'Enabled', need: 'Optional', rules: 'Yes or No. Default Yes. Applies to new metrics only.', example: 'Yes' },
  { name: 'Stale after (s)', need: 'Optional', rules: 'Whole number above 0. Default 120.', example: '120' },
];

// ---- step 1 -------------------------------------------------------------------------------------
export function StepFile({ file, busy, error, onFile, onTemplate, templateBusy }: {
  file: File | null; busy: boolean; error: MappedError | null; onFile: (f: File | null) => void; onTemplate: (f: ImportFormat) => void; templateBusy: ImportFormat | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  return (
    <div>
      <div className="bm-cols">
        <div>
          <div className="label">1. Get the template</div>
          <p className="muted bm-p">One row per metric. Repeat the appliance fields on each of its rows. Accounts must already exist; the import never creates accounts and never brings in alert rules, values or history.</p>
          <div className="bm-bar">
            <Button icon={<Download size={16} strokeWidth={1.5} />} onClick={() => onTemplate('xlsx')} busy={templateBusy === 'xlsx'} busyLabel="Preparing…">Template (.xlsx)</Button>
            <Button icon={<Download size={16} strokeWidth={1.5} />} onClick={() => onTemplate('csv')} busy={templateBusy === 'csv'} busyLabel="Preparing…">Template (.csv)</Button>
          </div>
          <p className="muted sm">The .xlsx has Instructions, Import and Example sheets. Column order is free; header names must match.</p>
        </div>
        <div>
          <div className="label">2. Choose your file</div>
          {error && error.kind === 'file' && (
            <div role="alert" className="banner banner--danger bm-filebanner">
              <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true" />
              <div className="banner__body"><b>{error.title}</b>{error.detail && <div className="muted sm">{error.detail}</div>}</div>
            </div>
          )}
          {file ? (
            <div className="bm-drop bm-drop--has" role="group" aria-label="Chosen file">
              <FileSpreadsheet size={20} strokeWidth={1.5} aria-hidden="true" className="muted" />
              <div className="bm-drop__text"><b className="truncate" title={file.name}>{file.name}</b><div className="muted sm">{sizeLabel(file.size)}. Read when you press Preview. Nothing is written.</div></div>
              <Button size="sm" variant="ghost" onClick={pick} disabled={busy}>Choose another file</Button>
            </div>
          ) : (
            <div className={cx('bm-drop', over && 'is-over', error?.kind === 'file' && 'is-bad')} role="group" aria-label="Choose file"
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
              <Upload size={24} strokeWidth={1.5} aria-hidden="true" />
              <b>Drop an .xlsx or .csv file here</b>
              <span className="muted">or</span>
              <Button data-autofocus onClick={pick} disabled={busy}>Choose file</Button>
              <span className="muted sm">Up to 500 data rows and 5 MiB. Nothing is saved until you apply.</span>
            </div>
          )}
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); }} />
          <p role="status" className="muted sm bm-p">{busy ? 'Reading the file…' : ''}</p>
        </div>
      </div>
      <div className="bm-stl"><span className="label">Columns</span><span className="muted sm">Header names are fixed</span></div>
      <div className="bm-box table-scroll">
        <table className="table table--compact">
          <caption className="sr-only">Import columns</caption>
          <thead><tr><th scope="col">Column</th><th scope="col">Need</th><th scope="col">Rules</th><th scope="col">Example</th></tr></thead>
          <tbody>
            {COLUMNS.map((c) => (
              <tr key={c.name}>
                <td className="mono">{c.name}</td>
                <td><span className={cx('badge', c.need.startsWith('Required') ? 'badge--accent' : 'badge--neutral')}>{c.need}</span></td>
                <td className="muted bm-wrap">{c.rules}</td>
                <td className="mono muted">{c.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="banner banner--info bm-infobanner"><div className="banner__body sm">Existing appliances and metrics are never changed or deleted. For an appliance that already exists, only blank Region, Location and Environment are filled, and only new metrics are added. A backup is taken before anything is written.</div></div>
    </div>
  );
}

// ---- step 2 -------------------------------------------------------------------------------------
const RESULT: Record<BamsRowState, { label: string; tone: string }> = {
  new: { label: 'New', tone: 'success' }, update: { label: 'Update', tone: 'info' }, unchanged: { label: 'Unchanged', tone: 'neutral' }, needs_review: { label: 'Needs review', tone: 'warning' }, invalid: { label: 'Invalid', tone: 'danger' },
};
const BADGE = { new: ['New appliance', 'success'], fills: ['Existing, fills blanks', 'info'], unchanged: ['Existing, unchanged', 'neutral'], review: ['Needs review', 'warning'] } as const;

export function StepPreview({ plan, notice, onChooseAnother }: { plan: BamsImportPlan; notice: string | null; onChooseAnother: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const groups = groupRows(plan, filter, search);
  const flagged = plan.review.length;
  const reviewRows = plan.counts.needs_review;
  return (
    <div>
      <div className="bm-filehead">
        <FileSpreadsheet size={16} strokeWidth={1.5} aria-hidden="true" />
        <b>{plan.file.name}</b>
        <span className="muted sm">{plan.file.rows_found} rows read{plan.file.format === 'xlsx' ? ` from sheet “${plan.file.sheet ?? 'Import'}”` : ' as CSV'}. Nothing has been written.</span>
        <span className="bm-bar__spacer" />
        <Button size="sm" variant="ghost" onClick={onChooseAnother}>Choose another file</Button>
      </div>
      <div className="bm-sumstrip" role="group" aria-label="Preview summary">
        <Sum label="Appliances new" n={plan.appliances.new} sub="to create" />
        <Sum label="Appliances updated" n={plan.appliances.updated} sub="fill blanks" />
        <Sum label="Metrics new" n={plan.metrics.new} sub="to create" />
        <Sum label="Metrics updated" n={plan.metrics.updated} sub={`unchanged: ${plan.metrics.unchanged}`} />
        <Sum label="Needs review" n={flagged} tone={flagged ? 'warning' : undefined} sub={`appliances, ${reviewRows} rows`} />
        <Sum label="Invalid" n={plan.counts.invalid} tone={plan.counts.invalid ? 'danger' : undefined} sub="rows skipped" />
      </div>
      {notice && <div role="status" className="banner banner--warning"><div className="banner__body sm">{notice}</div></div>}
      {plan.warnings.map((w) => <div key={w.text} role="status" className="banner banner--info"><div className="banner__body sm">{w.text}</div></div>)}
      {(flagged > 0 || plan.counts.invalid > 0) && (
        <div role="status" className="banner banner--warning">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" />
          <div className="banner__body sm">
            {flagged > 0 && <><b>{flagged} similar {flagged === 1 ? 'appliance needs' : 'appliances need'} a decision</b> before you can apply. Step 3 shows each one. </>}
            {plan.counts.invalid > 0 && <>{plan.counts.invalid} invalid {plan.counts.invalid === 1 ? 'row' : 'rows'} will be skipped and can be downloaded after you apply.</>}
          </div>
        </div>
      )}
      <div className="bm-bar">
        <TabStrip variant="chips" label="Filter rows" value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label, count: filterCount(plan, f.id) }))} />
        <span className="bm-bar__spacer" />
        <label className="bm-search"><Search size={14} strokeWidth={1.5} aria-hidden="true" /><input className="bm-search__input" type="search" aria-label="Search account, appliance or ticker" placeholder="Account, appliance or ticker" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
      </div>
      <div className="bm-box bm-box--tall">
        <table className="table table--compact">
          <caption className="sr-only">Import preview, grouped by account and appliance</caption>
          <thead><tr><th scope="col">Row</th><th scope="col">Metric</th><th scope="col">Ticker</th><th scope="col">Env</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {groups.length === 0 && <tr className="table__empty"><td colSpan={6}><span className="muted">No rows match this filter.</span></td></tr>}
            {groups.map((g) => (
              <GroupRows key={g.key} g={g} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted sm bm-foot">Rows are grouped by account and appliance. New metrics show <FreshnessBadge freshness="No Data" /> until the next poll.</p>
    </div>
  );
}

const Sum = ({ label, n, sub, tone }: { label: string; n: number; sub: string; tone?: 'warning' | 'danger' }) => (
  <div><div className="label">{label}</div><div className={cx('bm-sum__n num', tone && `bm-${tone}`)}>{n}</div><div className="muted sm">{sub}</div></div>
);

function GroupRows({ g }: { g: ReturnType<typeof groupRows>[number] }) {
  const b = g.badge ? BADGE[g.badge] : null;
  return (
    <>
      <tr className={cx('bm-grp', g.badge === 'review' && 'is-review')}>
        <td colSpan={6}>
          {g.orphan ? <b>Rows without a usable appliance</b> : <><b>{g.account}</b><span className="subtle"> / </span><b className="mono">{g.appliance}</b></>}
          {b && <span className={cx('badge', `badge--${b[1]}`, 'bm-grp__badge')}>{b[0]}</span>}
          {g.sub && <span className="bm-grp__sub"> {g.sub}</span>}
        </td>
      </tr>
      {g.rows.map((r) => (
        <tr key={r.row} className={cx(r.state === 'invalid' && 'bm-inv', r.state === 'needs_review' && 'bm-rev')} data-state={r.state}>
          <td className="num muted">{r.row}</td>
          <td className="bm-ind">{r.values.metric ?? <span className="subtle">-</span>}</td>
          <td className="mono">{r.values.ticker ?? <span className="subtle">-</span>}</td>
          <td>{r.values.environment ?? <span className="subtle">-</span>}</td>
          <td><span className={cx('badge', `badge--${RESULT[r.state].tone}`)}>{r.state === 'invalid' && <AlertCircle size={12} strokeWidth={1.5} aria-hidden="true" />}{RESULT[r.state].label}</span></td>
          <td className={cx('bm-wrap', r.state === 'invalid' ? 'bm-why' : 'muted')}>{r.state === 'invalid' ? (r.errors[0]?.text ?? 'Invalid row. Row skipped.') : (r.notes[0] ?? '')}</td>
        </tr>
      ))}
    </>
  );
}

// ---- step 3 -------------------------------------------------------------------------------------
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function StepReview({ plan, decisions, onChoose, notice, errorKeys, error }: {
  plan: BamsImportPlan; decisions: Decisions; onChoose: (g: BamsReviewGroup, choice: BamsChoice, viewed: BamsCandidate['ref']) => void; notice: string | null; errorKeys: string[]; error: string | null;
}) {
  const [viewed, setViewed] = useState<Record<string, number>>({});
  return (
    <div>
      <p className="muted bm-p">Compared only within the same account. The same appliance name in another account is never flagged. Nothing is preselected.</p>
      {notice && <div role="status" className="banner banner--warning"><div className="banner__body sm">{notice}</div></div>}
      {error && <p role="alert" className="bm-error">{error}</p>}
      {plan.review.map((g, i) => (
        <ReviewCard key={g.key} g={g} index={i} total={plan.review.length} decisions={decisions} flagged={errorKeys.includes(g.key)} viewedIndex={viewed[g.key] ?? 0}
          setViewed={(n) => setViewed((v) => ({ ...v, [g.key]: n }))} onChoose={onChoose} />
      ))}
    </div>
  );
}

function ReviewCard({ g, index, total, decisions, flagged, viewedIndex, setViewed, onChoose }: {
  g: BamsReviewGroup; index: number; total: number; decisions: Decisions; flagged: boolean; viewedIndex: number; setViewed: (n: number) => void; onChoose: (g: BamsReviewGroup, c: BamsChoice, ref: BamsCandidate['ref']) => void;
}) {
  const gid = useId();
  const cand = g.candidates[Math.min(viewedIndex, g.candidates.length - 1)];
  const d = decisions[g.key];
  const sameDisabled = candidateDisabled(cand, decisions);
  const choice = d?.choice;
  const reason = cand.reasons[0]?.text ?? '';
  const fillText = Object.entries(cand.fills).map(([k, v]) => `blank ${cap(k)} is filled with ${v}`).join('; ');
  const opt = (value: BamsChoice, title: string, small: string, disabled?: boolean) => (
    <label className={cx('bm-radopt', choice === value && 'is-on', disabled && 'is-disabled')}>
      <input type="radio" name={`${gid}-choice`} className="bm-radopt__input" checked={choice === value} disabled={disabled} onChange={() => onChoose(g, value, cand.ref)} />
      <span className="bm-radopt__dot" aria-hidden="true" />
      <span><b>{title}</b><small>{small}</small></span>
    </label>
  );
  return (
    <section className={cx('bm-rc', flagged && 'is-flagged')} aria-label={`Similar appliance ${index + 1}`}>
      <header className="bm-rc__head">
        <b>{index + 1} of {total}</b><span className="subtle">/</span><b>{g.client_name}</b>
        <span className={cx('badge', g.strength === 'High' ? 'badge--warning' : 'badge--neutral')}>{g.strength} similarity</span>
        <span className="bm-bar__spacer" />
        <span className="muted sm">{reason}</span>
      </header>
      <div className="bm-rc__body">
        {g.candidates.length > 1 && (
          <div className="bm-compare">
            <span className="muted sm" id={`${gid}-cmp`}>Compare with</span>
            <Select size="sm" aria-label={`Compare ${g.file.appliance} with`} value={String(viewedIndex)} options={g.candidates.map((c, n) => ({ value: String(n), label: `${c.name} (${c.strength})` }))} onChange={(v) => { const n = Number(v ?? 0); setViewed(n); if (choice === 'same') onChoose(g, 'same', g.candidates[n].ref); }} />
          </div>
        )}
        <div className="bm-sbs">
          <div>
            <div className="label">In your file</div>
            <div className="bm-nm mono">{g.file.appliance}</div>
            <Fr k="Rows" v={`${g.file.metrics.length} ${g.file.metrics.length === 1 ? 'metric' : 'metrics'} (row${g.rows.length > 1 ? 's' : ''} ${g.rows.join(', ')})`} />
            <Fr k="Region" v={g.file.region} />
            <Fr k="Location" v={g.file.location} diff={!!cand.fills.location} />
            <Fr k="Environment" v={g.file.environment} />
          </div>
          <div>
            <div className="label">{cand.ref.type === 'group' ? 'Earlier in this file for' : 'Already in'} {g.client_name}</div>
            <div className="bm-nm mono">{cand.name}</div>
            <Fr k={cand.ref.type === 'group' ? 'Rows' : 'Metrics'} v={`${cand.metric_count}${cand.metrics.length ? ` (${cand.metrics.join(', ')})` : ''}`} />
            <Fr k="Region" v={cand.region} blank />
            <Fr k="Location" v={cand.location} blank />
            <Fr k="Environment" v={cand.environment} blank />
          </div>
        </div>
        <div role="radiogroup" aria-label={`Decision for ${g.file.appliance}`} className="bm-rad">
          {opt('same', 'Same appliance', `Add the file’s metrics to ${cand.name}. Existing metrics keep their tickers and settings.`, sameDisabled)}
          {opt('different', 'Different appliance', `Create ${g.file.appliance} as a new appliance.`)}
          {opt('skip', 'Skip', `Ignore all ${g.rows.length} rows for ${g.file.appliance}.`)}
        </div>
        {sameDisabled && <p className="muted sm">“Same appliance” is unavailable while {cand.name} is set to Skip.</p>}
        {choice === 'same' && !sameDisabled && (
          <div className="bm-anno" role="status">
            Result of Same appliance: {cand.metrics_added.length ? `${cand.metrics_added.join(', ')} ${cand.metrics_added.length === 1 ? 'is' : 'are'} added; ` : 'no metric is added; '}
            {cand.metrics_existing.length ? `${cand.metrics_existing.join(' and ')} already ${cand.metrics_existing.length === 1 ? 'exists' : 'exist'} and stay unchanged; ` : ''}
            {fillText ? `${fillText}. ` : ''}Nothing is removed.
            {cand.metrics_conflicts.length > 0 && ` Rows with a ticker already used elsewhere are skipped (${cand.metrics_conflicts.map((c) => c.metric).join(', ')}).`}
          </div>
        )}
        {(cand.differences.length > 0 || cand.reasons.length > 1) && <ul className="bm-reasons muted sm">{[...cand.reasons.slice(1), ...cand.differences].map((r) => <li key={r.code + r.text}>{r.text}</li>)}</ul>}
      </div>
    </section>
  );
}

function Fr({ k, v, diff, blank }: { k: string; v: string | null; diff?: boolean; blank?: boolean }) {
  return (
    <div className="bm-fr"><span className="k">{k}</span><span>{v ? (diff ? <span className="bm-diffv">{v}</span> : v) : <span className="subtle">{blank ? 'blank' : '-'}</span>}</span></div>
  );
}

// ---- step 4 -------------------------------------------------------------------------------------
export function StepResult({ r, failure, onDownload, downloadBusy, onBackToPreview, onRetry, onAnother, error }: {
  r: BamsImportResult | null; failure: MappedError | null; onDownload: (f: ImportFormat) => void; downloadBusy: boolean; onBackToPreview: () => void; onRetry: () => void; onAnother: () => void; error: string | null;
}) {
  if (failure) {
    return (
      <div>
        <div role="alert" className="banner banner--danger">
          <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true" />
          <div className="banner__body"><b>{failure.title}</b><div className="muted sm">The database refused the write{failure.failed?.row ? ` at row ${failure.failed.row}` : ''} and every change was rolled back. No appliance, metric or audit entry from this file exists.</div></div>
        </div>
        <div className="bm-sres">
          {['Appliances created', 'Appliances updated', 'Metrics created', 'Metrics updated'].map((l) => <div key={l}><div className="label">{l}</div><div className="bm-sum__n num">0</div></div>)}
        </div>
        <dl className="bm-kvl">
          {failure.failed?.reason && <><dt>Reason</dt><dd>{failure.failed.reason}</dd></>}
          {failure.failed?.backup && <><dt>Backup</dt><dd>Pre-import backup kept ({failure.failed.backup}), not needed for recovery.</dd></>}
        </dl>
        <div className="bm-bar"><Button onClick={onBackToPreview}>Back to preview</Button><Button onClick={onRetry}>Try apply again</Button><span className="bm-bar__spacer" /><Link to="/bams" className="btn btn--primary btn--md"><span className="btn__label">Open BAMS</span></Link></div>
      </div>
    );
  }
  if (!r) return null;
  const c = r.counts;
  const nothing = c.appliances_created + c.appliances_updated + c.metrics_created + c.metrics_updated === 0;
  return (
    <div>
      <div role="status" className="banner bm-okbanner">
        <CheckCircle2 size={16} strokeWidth={1.5} aria-hidden="true" />
        <div className="banner__body"><b>{nothing ? 'Nothing needed to change' : 'Import complete'}</b><div className="muted sm">{r.file.name} applied at {new Date(r.applied_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. {r.backup ? 'A backup was saved first.' : 'Nothing was written, so no backup was needed.'}</div></div>
      </div>
      <div className="bm-sres">
        <div><div className="label">Appliances created</div><div className="bm-sum__n num bm-success">{c.appliances_created}</div></div>
        <div><div className="label">Appliances updated</div><div className="bm-sum__n num">{c.appliances_updated}</div><div className="muted sm">{c.appliances_unchanged} unchanged</div></div>
        <div><div className="label">Metrics created</div><div className="bm-sum__n num bm-success">{c.metrics_created}</div></div>
        <div><div className="label">Metrics updated</div><div className="bm-sum__n num">{c.metrics_updated}</div><div className="muted sm">{c.metrics_unchanged} unchanged</div></div>
      </div>
      <dl className="bm-kvl">
        <dt>Skipped rows</dt>
        <dd>{c.skipped === 0 ? 'None' : <><b className="bm-danger">{c.skipped}</b> ({c.invalid} invalid{r.breakdown.skipped_by_user ? `, ${r.breakdown.skipped_by_user} skipped by you` : ''}; rows {r.skipped.map((s) => s.row).join(', ')})</>}</dd>
        {r.decisions.length > 0 && <><dt>Your decisions</dt><dd>{r.decisions.map((d) => d.label).join('; ')}</dd></>}
        <dt>Monitoring</dt><dd>New metrics show <FreshnessBadge freshness="No Data" /> until the next poll.</dd>
        {r.audit_events > 0 && <><dt>Audit</dt><dd>{r.audit_events} events recorded ({r.audit_breakdown.appliance ?? 0} appliance, {r.audit_breakdown.metric ?? 0} metric)</dd></>}
      </dl>
      {error && <p role="alert" className="bm-error">{error}</p>}
      <div className="bm-bar">
        {r.skipped_url && (
          <>
            <Button icon={<Download size={16} strokeWidth={1.5} />} busy={downloadBusy} busyLabel="Preparing…" onClick={() => onDownload(r.file.format)}>Download skipped rows (.{r.file.format})</Button>
          </>
        )}
        <span className="bm-bar__spacer" />
        <Button variant="ghost" onClick={onAnother}>Import another file</Button>
        <Link to={openBamsPath(r)} className="btn btn--primary btn--md"><span className="btn__label">Open BAMS</span></Link>
      </div>
    </div>
  );
}

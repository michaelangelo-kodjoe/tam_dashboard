import { useMemo, useState } from 'react';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StatusBadge, type Tone } from '../ui/Badges';
import type { ImportPlan, ImportRow } from '../../types';
import { FIELD_LABEL, filterRows, unchangedCount, type Filter } from './importState';
import { dash } from './ImportParts';

const STATE: Record<ImportRow['state'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'info' },
  update: { label: 'Update', tone: 'neutral' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  invalid: { label: 'Invalid', tone: 'danger' },
};

export function rowDetail(r: ImportRow): string {
  if (r.state === 'invalid') return r.errors.map((e) => e.text).join(' ');
  const extra = [...(r.match?.notes ?? []), ...r.warnings.map((w) => w.text)];
  const tail = extra.length ? ` ${extra.join('. ')}.` : '';
  if (r.merged_into) return `Same name as row ${r.merged_into.row} in this file; fills blanks in that account.${tail}`;
  if (r.state === 'new') return 'New account';
  if (r.state === 'update') {
    const fills = Object.keys(r.match?.fills ?? {}).map((k) => FIELD_LABEL[k] ?? k);
    const m = r.match?.reasons[0]?.code === 'exact_name' ? 'Exact name match' : 'Exact match';
    return `${m}. ${fills.length ? `Fills: ${fills.join(', ')}` : 'Nothing to fill; no change'}.${tail}`;
  }
  const top = r.candidates[0];
  if (!top) return 'Needs review';
  const where = top.ref.type === 'row' ? `row ${top.ref.row} in this file: ${top.name}` : top.name;
  const more = r.candidates.length > 1 ? ` (+${r.candidates.length - 1} more)` : '';
  return `Similar to ${where}${more}: ${top.reasons.map((x) => x.text).join('; ')} (${top.strength} match)`;
}

function Tile({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="imp-tile">
      <span className="label">{label}</span>
      <span className={`imp-tile__n num ${value === 0 ? 'subtle' : tone === 'danger' ? 'danger-text' : tone === 'warning' ? 'warning-text' : ''}`}>{value}</span>
      <span className="muted sm">{sub}</span>
    </div>
  );
}

export function StepPreview({ plan, notice }: { plan: ImportPlan; notice: string | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => filterRows(plan, filter), [plan, filter]);
  const c = plan.counts;
  const un = unchangedCount(plan);
  const opts: { value: Filter; label: string }[] = [
    { value: 'all', label: `All ${c.rows}` }, { value: 'new', label: `New ${c.new}` }, { value: 'update', label: `Updates ${c.updates}` },
    { value: 'needs_review', label: `Needs review ${c.needs_review}` }, { value: 'invalid', label: `Invalid ${c.invalid}` },
  ];
  return (
    <div className="imp-preview">
      <p className="muted sm imp-filechip">{plan.file.name} · {plan.file.format === 'csv' ? 'CSV file' : 'Excel workbook (.xlsx)'}</p>
      {notice && <p role="status" className="imp-notice">{notice}</p>}
      {(plan.file.notes.length > 0 || plan.warnings.length > 0) && (
        <ul className="imp-notice imp-notice--list" aria-label="File notes">
          {plan.file.notes.map((n) => <li key={n}>{n}</li>)}
          {plan.warnings.map((w) => <li key={w.code + w.text}>{w.text}</li>)}
        </ul>
      )}
      <div className="imp-tiles" role="group" aria-label="Counts">
        <Tile label="Valid" value={c.valid} sub={`of ${c.rows} rows`} />
        <Tile label="New" value={c.new} sub="create" />
        <Tile label="Updates" value={c.updates} sub={un > 0 ? `fill blanks; ${un} unchanged` : 'fill blanks'} />
        <Tile label="Needs review" value={c.needs_review} sub="confirm each" tone="warning" />
        <Tile label="Invalid" value={c.invalid} sub="will be skipped" tone="danger" />
      </div>
      <SegmentedControl<Filter> label="Filter rows by result" size="sm" value={filter} onChange={setFilter} options={opts} />
      <div className="table-scroll imp-tablewrap" tabIndex={0} role="region" aria-label="Import rows">
        <table className="table table--compact imp-table">
          <caption className="sr-only">Rows read from the file, {rows.length} shown</caption>
          <thead><tr><th scope="col">Row</th><th scope="col">Account name</th><th scope="col">BPID</th><th scope="col">Products</th><th scope="col">Status</th><th scope="col">Next contact</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const v = r.values;
              const raw = r.raw ?? {};
              const s = STATE[r.state];
              const detail = rowDetail(r);
              return (
                <tr key={r.row}>
                  <td className="num">{r.row}</td>
                  <td>{r.state === 'invalid' && !v.name && !raw.name ? <span className="subtle">(empty)</span> : (v.name ?? raw.name)}</td>
                  <td className="mono">{dash(v.bpid ?? raw.bpid)}</td>
                  <td>{dash(v.products ?? raw.products)}</td>
                  <td>{dash(v.status ?? raw.status)}</td>
                  <td className="num">{dash(v.next_contact ?? raw.next_contact)}</td>
                  <td><StatusBadge value={s.label} tone={s.tone}>{r.state === 'update' && r.unchanged ? 'Unchanged' : s.label}</StatusBadge></td>
                  <td className={`imp-detail ${r.state === 'invalid' ? 'danger-text' : ''}`} title={detail}>{detail}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr className="table__empty"><td colSpan={8} className="muted">No rows match this filter.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted sm">Showing {rows.length} of {c.rows} rows (up to 500 per import). Nothing has been written yet.</p>
    </div>
  );
}

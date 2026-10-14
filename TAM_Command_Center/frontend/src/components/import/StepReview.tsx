import { useEffect, useRef } from 'react';
import { Button } from '../ui/Button';
import { cx } from '../../lib/cx';
import type { ImportChoice, ImportPlan, ImportRow, SimilarCandidate } from '../../types';
import { SegmentedControl } from '../ui/SegmentedControl';
import { candidateDisabled, chooseOption, chooseTarget, flaggedRows, isResolved, resolvedCount, type Decisions } from './importState';
import { Facts, FillKeep, RadioList, Reasons, StrengthBadge, dash } from './ImportParts';

const LABEL: Record<ImportChoice, string> = { same: 'Same account', different: 'Different account', skip: 'Skip' };

function fileRowLabel(c: SimilarCandidate, plan: ImportPlan): string {
  if (c.ref.type !== 'row') return '';
  const src = plan.rows.find((r) => r.row === (c.ref as { row: number }).row);
  const tail = src?.state === 'update' && src.match ? `updates the existing account ${src.match.account.name}` : src?.state === 'needs_review' ? 'also needs a decision' : 'will be created as new';
  return `Row ${c.ref.row} in this file (${tail})`;
}

function CandidateBlock({ c, row, only, plan }: { c: SimilarCandidate; row: ImportRow; only: boolean; plan: ImportPlan }) {
  const inFile = c.ref.type === 'row';
  return (
    <div className="imp-cand">
      <div className="label">{inFile ? fileRowLabel(c, plan) : only ? 'Existing account' : 'Possible match'}</div>
      <div className="imp-cand__head">
        <b>{c.name}</b>
        <StrengthBadge strength={c.strength} />
      </div>
      <Facts c={c} />
      <Reasons reasons={c.reasons} differences={c.differences} />
      <FillKeep fills={c.fills} kept={c.kept} notes={c.notes} />
      {row.candidates.length > 1 && <span className="sr-only">Candidate {row.candidates.indexOf(c) + 1} of {row.candidates.length}</span>}
    </div>
  );
}

interface Props {
  plan: ImportPlan;
  decisions: Decisions;
  onChange: (d: Decisions) => void;
  selected: number;
  onSelect: (row: number) => void;
  notice: string | null;
  error: string | null;
  errorRows: number[];
}

export function StepReview({ plan, decisions, onChange, selected, onSelect, notice, error, errorRows }: Props) {
  const flagged = flaggedRows(plan);
  const row = flagged.find((r) => r.row === selected) ?? flagged[0];
  const done = resolvedCount(plan, decisions);
  const detailRef = useRef<HTMLElement>(null);
  const choiceRef = useRef<HTMLDivElement>(null);
  useEffect(() => { /* keep the detail pane scrolled to top when the row changes */ detailRef.current?.scrollTo?.({ top: 0 }); }, [row?.row]);
  if (!row) return <p className="muted">Nothing needs review.</p>;
  const d = decisions[row.row];
  const next = flagged.find((r) => r.row !== row.row && !isResolved(r, decisions));
  const multi = row.candidates.length > 1;
  const subLabel = (r: ImportRow) => {
    const x = decisions[r.row];
    if (!x) return 'Needs a choice';
    if (x.choice === 'same' && !isResolved(r, decisions)) return 'Same account: pick which one';
    return LABEL[x.choice];
  };
  return (
    <div className="imp-review">
      <div className="imp-review__bar">
        <p className="imp-progress" role="status"><b className="num">{done} of {flagged.length} resolved</b> <span className="muted">Confirm each one. Nothing is written until you click Apply.</span></p>
        {notice && <p role="status" className="imp-notice">{notice}</p>}
        {error && <p role="alert" className="imp-error">{error}</p>}
      </div>
      <div className="imp-review__grid">
        <nav aria-label="Rows to review" className="imp-list">
          <ul>
            {flagged.map((r) => {
              const ok = isResolved(r, decisions);
              return (
                <li key={r.row}>
                  <button type="button" className={cx('imp-list__item', r.row === row.row && 'is-on', errorRows.includes(r.row) && 'is-error')} aria-current={r.row === row.row ? 'true' : undefined} onClick={() => onSelect(r.row)}>
                    <span className="imp-list__name">{r.values.name}</span>
                    <span className={cx('sm', ok ? 'muted' : 'warning-text')}>Row {r.row} · {subLabel(r)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <section ref={detailRef} className="imp-detailpane" aria-label={`Row ${row.row}: ${row.values.name}`}>
          <div className="imp-filerow">
            <div className="label">In your file · row {row.row}</div>
            <b>{row.values.name}</b>
            <p className="imp-facts muted sm">
              <span>BPID <span className="mono">{dash(row.values.bpid)}</span></span><span>{dash(row.values.products)}</span><span>{dash(row.values.status)}</span>
              <span>Next contact <span className="num">{dash(row.values.next_contact)}</span></span>
            </p>
            {row.values.notes && <p className="muted sm">Notes: {row.values.notes}</p>}
          </div>
          {row.candidates.map((c) => <CandidateBlock key={c.ref.type === 'account' ? c.ref.id : `r${c.ref.row}`} c={c} row={row} only={!multi} plan={plan} />)}
          <div ref={choiceRef} className="imp-decision">
            <div className="label" id={`dec-${row.row}`}>Decision</div>
            <SegmentedControl<ImportChoice | ''>
              label={`Decision for row ${row.row}, ${row.values.name}`}
              value={d?.choice ?? ''}
              onChange={(v) => v && onChange(chooseOption(plan, decisions, row.row, v))}
              options={(['same', 'different', 'skip'] as ImportChoice[]).map((k) => ({ value: k, label: LABEL[k] }))}
              className="imp-seg3"
            />
            <p className="muted sm">Same account: merge as above. Different account: create a new account. Skip: leave this row out.</p>
            {d?.choice === 'same' && multi && (
              <div className="imp-target">
                <div className="label">Same as which account?</div>
                <RadioList
                  label={`Which account is row ${row.row} the same as`}
                  value={d.target ? (d.target.type === 'account' ? d.target.id : `row-${d.target.row}`) : null}
                  onChange={(v) => {
                    const c = row.candidates.find((x) => (x.ref.type === 'account' ? x.ref.id : `row-${x.ref.row}`) === v);
                    if (c) onChange(chooseTarget(decisions, row.row, c.ref));
                  }}
                  options={row.candidates.map((c) => ({
                    value: c.ref.type === 'account' ? c.ref.id : `row-${c.ref.row}`,
                    label: c.name,
                    sub: c.ref.type === 'row' ? `Row ${c.ref.row} of this file${candidateDisabled(c, decisions) ? ' (skipped, cannot be used)' : ''}` : `Existing account · ${c.strength} match`,
                    disabled: candidateDisabled(c, decisions),
                  }))}
                />
                {!d.target && <p className="warning-text sm">Choose one account to finish this row.</p>}
              </div>
            )}
            {d?.choice === 'same' && !multi && row.candidates[0] && candidateDisabled(row.candidates[0], decisions) && (
              <p className="warning-text sm">Row {row.candidates[0].ref.type === 'row' ? row.candidates[0].ref.row : ''} is marked Skip, so this row cannot be merged into it. Choose another option.</p>
            )}
          </div>
          <div className="imp-nextrow">
            <Button size="sm" onClick={() => next && onSelect(next.row)} disabled={!next}>Next row that needs a choice</Button>
          </div>
        </section>
      </div>
    </div>
  );
}

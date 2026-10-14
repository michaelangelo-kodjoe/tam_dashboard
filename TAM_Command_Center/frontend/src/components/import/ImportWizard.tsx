// Import accounts wizard (docs/01_PM_SPEC.md §11.1, mockups import/01..05 as amended by D-42/D-48).
// Steps: 1 Choose file, 2 Preview, 3 Review duplicates (skipped when nothing is flagged), 4 Result.
// Nothing is written before Apply; all data access goes through the DataSource.
import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { useData } from '../../store/DataContext';
import { cx } from '../../lib/cx';
import { saveFile } from '../../lib/download';
import type { ImportFormat, ImportPlan, ImportResult } from '../../types';
import { StepFile } from './StepFile';
import { StepPreview } from './StepPreview';
import { StepReview } from './StepReview';
import { StepResult } from './StepResult';
import {
  canApply, carryDecisions, flaggedRows, mapImportError, needsDiscardGuard, toRequest, unresolvedRows, type Decisions, type MappedError, type Step,
} from './importState';

const STEPS: { id: Step; label: string }[] = [
  { id: 'file', label: 'Choose file' }, { id: 'preview', label: 'Preview' }, { id: 'review', label: 'Review duplicates' }, { id: 'result', label: 'Result' },
];

export function ImportWizard({ onClose }: { onClose: () => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const [step, setStep] = useState<Step>('file');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<null | 'inspect' | 'apply' | 'refresh' | 'skipped'>(null);
  const [templateBusy, setTemplateBusy] = useState<ImportFormat | null>(null);
  const [error, setError] = useState<MappedError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Move focus to the step heading whenever the step changes (not on first render: the drop zone takes it).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (step !== 'result') headRef.current?.focus();
  }, [step]);

  const expired = error?.kind === 'expired';
  const guard = needsDiscardGuard(step, plan, result) && !expired;
  const requestClose = () => {
    if (busy === 'apply' || busy === 'inspect') return;
    if (guard) setConfirmDiscard(true);
    else onClose();
  };

  const startOver = () => { setPlan(null); setDecisions({}); setResult(null); setError(null); setNotice(null); setStep('file'); };

  const onFile = async (f: File) => {
    setBusy('inspect');
    setError(null);
    try {
      const p = await ds.inspectAccountsImport(f);
      setPlan(p);
      setDecisions({});
    } catch (e) {
      setPlan(null);
      setError(mapImportError(e));
    } finally { setBusy(null); }
  };

  const onTemplate = async (fmt: ImportFormat) => {
    setTemplateBusy(fmt);
    try { saveFile(await ds.downloadImportTemplate(fmt)); }
    catch (e) { setError(mapImportError(e)); }
    finally { setTemplateBusy(null); }
  };

  const goReviewOrApply = () => {
    if (!plan) return;
    setError(null);
    if (flaggedRows(plan).length > 0) {
      const un = unresolvedRows(plan, decisions)[0] ?? flaggedRows(plan)[0].row;
      setSelected(un);
      setNotice(null);
      setStep('review');
    } else void apply();
  };

  const apply = async () => {
    if (!plan) return;
    setBusy('apply');
    setError(null);
    try {
      const r = await ds.applyAccountsImport(toRequest(plan, decisions));
      setResult(r);
      setStep('result');
      bump();
      toast.push({ kind: 'success', message: `Import applied: ${r.counts.created} created, ${r.counts.updated} updated` });
    } catch (e) {
      const m = mapImportError(e);
      if (m.kind === 'applied' && m.result) { setResult(m.result); setStep('result'); bump(); }
      else if (m.kind === 'stale') await refreshAfterStale(m);
      else if (m.kind === 'unresolved') {
        setError(m);
        setStep('review');
        if (m.rows?.[0] !== undefined) setSelected(m.rows[0]);
      } else setError(m);
    } finally { setBusy(null); }
  };

  const refreshAfterStale = async (m: MappedError) => {
    if (!plan) return;
    setBusy('refresh');
    try {
      const fresh = await ds.getAccountsImport(plan.import_id);
      const c = carryDecisions(plan, fresh, decisions);
      setPlan(fresh);
      setDecisions(c.decisions);
      const flagged = flaggedRows(fresh);
      setNotice(
        c.changed.length
          ? `${m.message} ${c.changed.length} ${c.changed.length === 1 ? 'row needs' : 'rows need'} a fresh decision: row ${c.changed.join(', ')}.`
          : `${m.message} Your decisions were kept.`,
      );
      setError(null);
      if (flagged.length > 0) { setSelected(c.changed[0] ?? flagged[0].row); setStep('review'); } else setStep('preview');
    } catch (e) { setError(mapImportError(e)); }
    finally { setBusy(null); }
  };

  const onSkipped = async (fmt: ImportFormat) => {
    if (!result) return;
    setBusy('skipped');
    setError(null);
    try { saveFile(await ds.downloadSkippedRows(result.import_id, fmt)); }
    catch (e) { setError(mapImportError(e)); }
    finally { setBusy(null); }
  };

  const idx = STEPS.findIndex((s) => s.id === step);
  const title = STEPS[idx].label;
  const flagged = plan ? flaggedRows(plan).length : 0;
  const hasReview = flagged > 0;

  let footer;
  let note: string | null = null;
  if (expired) {
    footer = (<><Button onClick={onClose}>Close</Button><Button variant="primary" onClick={startOver} data-autofocus>Choose the file again</Button></>);
  } else if (step === 'file') {
    note = 'A safety backup is taken automatically when you apply.';
    footer = (<><Button onClick={requestClose}>Cancel</Button><Button variant="primary" disabled={!plan || busy !== null} onClick={() => { setError(null); setStep('preview'); }}>Preview</Button></>);
  } else if (step === 'preview' && plan) {
    const invalid = plan.counts.invalid;
    note = plan.counts.valid === 0
      ? 'No row can be imported. Fix the file and choose it again.'
      : `${hasReview ? `${flagged} ${flagged === 1 ? 'row needs' : 'rows need'} your decision before you can apply. ` : ''}${invalid ? `${invalid} invalid ${invalid === 1 ? 'row' : 'rows'} will be skipped.` : ''}`.trim() || 'Nothing has been written yet.';
    footer = (
      <>
        <Button onClick={() => setStep('file')} disabled={busy !== null}>Back</Button>
        <Button variant="primary" busy={busy === 'apply'} busyLabel="Applying…" disabled={plan.counts.valid === 0 || busy !== null} onClick={goReviewOrApply}>
          {hasReview ? `Review ${flagged} ${flagged === 1 ? 'duplicate' : 'duplicates'}` : 'Apply import'}
        </Button>
      </>
    );
  } else if (step === 'review' && plan) {
    note = '';
    footer = (
      <>
        <Button onClick={() => { setNotice(null); setStep('preview'); }} disabled={busy !== null}>Back to preview</Button>
        <Button variant="primary" busy={busy === 'apply'} busyLabel="Applying…" disabled={!canApply(plan, decisions) || busy !== null} onClick={() => void apply()}
          aria-describedby="imp-apply-hint">Apply import</Button>
      </>
    );
  } else {
    footer = (<Button variant="primary" onClick={onClose} data-autofocus>Done</Button>);
  }

  return (
    <>
      <Dialog
        title="Import accounts"
        width={step === 'review' || step === 'preview' ? 1040 : 880}
        onClose={requestClose}
        closable={busy !== 'apply' && busy !== 'inspect' && !confirmDiscard}
        closeOnScrim={false}
        footer={
          <div className="imp-foot">
            <p className="muted sm imp-foot__note" id="imp-apply-hint">{note}{step === 'review' && plan && !canApply(plan, decisions) ? 'Apply stays disabled until every row is resolved.' : ''}</p>
            <div className="imp-foot__btns">{footer}</div>
          </div>
        }
      >
        <ol className="imp-steps" aria-label="Import steps">
          {STEPS.map((s, i) => {
            const skipped = s.id === 'review' && plan && !hasReview && step !== 'review';
            return (
              <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className={cx('imp-steps__item', s.id === step && 'is-current', i < idx && 'is-done', skipped && 'is-skipped')}>
                <span className="imp-steps__n" aria-hidden="true">{i + 1}</span>
                <span>{s.label}{i < idx ? <span className="sr-only"> (done)</span> : null}{skipped ? <span className="sr-only"> (not needed)</span> : null}</span>
              </li>
            );
          })}
        </ol>
        {step === 'result' && !expired ? null : <h3 ref={headRef} tabIndex={-1} className="imp-h">{expired ? 'This import timed out' : title}</h3>}
        {expired ? (
          <p role="alert" className="imp-error">{error!.message}</p>
        ) : step === 'file' ? (
          <StepFile plan={plan} busy={busy === 'inspect'} error={error && error.kind !== 'applied' ? error.message : null} onFile={(f) => void onFile(f)}
            onRemove={() => { setPlan(null); setDecisions({}); setError(null); }} onTemplate={(f) => void onTemplate(f)} templateBusy={templateBusy} />
        ) : step === 'preview' && plan ? (
          <>
            {error && <p role="alert" className="imp-error">{error.message}</p>}
            <StepPreview plan={plan} notice={notice} />
          </>
        ) : step === 'review' && plan ? (
          <StepReview plan={plan} decisions={decisions} onChange={setDecisions} selected={selected} onSelect={setSelected} notice={notice}
            error={error?.message ?? null} errorRows={error?.kind === 'unresolved' ? error.rows ?? [] : []} />
        ) : result ? (
          <StepResult r={result} onDownload={(f) => void onSkipped(f)} busy={busy === 'skipped'} error={error?.message ?? null} />
        ) : null}
      </Dialog>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this import?"
          description="Nothing has been written to your accounts. If you close now, you will need to choose the file again."
          confirmLabel="Discard import"
          cancelLabel="Keep working"
          cancelVariant="primary"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => { setConfirmDiscard(false); onClose(); }}
        />
      )}
    </>
  );
}

// BAMS appliance and metrics import (docs/01_PM_SPEC.md §12.8, mockups 09-13). A page, not a dialog.
// Steps: 1 Choose file, 2 Preview, 3 Review similar (skipped when nothing is flagged), 4 Result.
// Nothing is written before Apply; all access goes through the DataSource.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ChevronRight } from 'lucide-react';
import { PageHeader } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { StepFile, StepPreview, StepResult, StepReview } from '../../components/bams/ImportSteps';
import { canApply, carryDecisions, choose, mapBamsError, resolvedCount, toRequest, unresolvedKeys, type Decisions, type MappedError, type Step } from '../../components/bams/importState';
import { useData } from '../../store/DataContext';
import { useDocumentTitle } from '../../lib/hooks';
import { saveFile } from '../../lib/download';
import { cx } from '../../lib/cx';
import type { BamsImportPlan, BamsImportResult } from '../../bamsTypes';
import type { ImportFormat } from '../../types';

const STEPS: { id: Step; label: string }[] = [{ id: 'file', label: 'Choose file' }, { id: 'preview', label: 'Preview' }, { id: 'review', label: 'Review similar' }, { id: 'result', label: 'Result' }];

export function ImportPage() {
  useDocumentTitle('Import appliances');
  const { ds, bump } = useData();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<BamsImportPlan | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [result, setResult] = useState<BamsImportResult | null>(null);
  const [busy, setBusy] = useState<null | 'inspect' | 'apply' | 'refresh' | 'skipped'>(null);
  const [templateBusy, setTemplateBusy] = useState<ImportFormat | null>(null);
  const [error, setError] = useState<MappedError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } headRef.current?.focus(); }, [step]);

  const flagged = plan?.review.length ?? 0;
  const expired = error?.kind === 'expired';
  const failure = error?.kind === 'failed' ? error : null;
  const idx = STEPS.findIndex((s) => s.id === step);

  const startOver = () => { setFile(null); setPlan(null); setDecisions({}); setResult(null); setError(null); setNotice(null); setStep('file'); };
  const cancel = () => { if (plan && !result) setConfirmLeave(true); else navigate('/bams'); };

  const inspect = async () => {
    if (!file) return;
    setBusy('inspect'); setError(null);
    try { const p = await ds.inspectBamsImport(file); setPlan(p); setDecisions({}); setNotice(null); setStep('preview'); }
    catch (e) { setPlan(null); setError(mapBamsError(e)); }
    finally { setBusy(null); }
  };
  const onTemplate = async (fmt: ImportFormat) => {
    setTemplateBusy(fmt);
    try { saveFile(await ds.downloadBamsImportTemplate(fmt)); } catch (e) { setError(mapBamsError(e)); } finally { setTemplateBusy(null); }
  };

  const refreshAfterStale = async (m: MappedError) => {
    if (!plan) return;
    setBusy('refresh');
    try {
      const fresh = await ds.getBamsImport(plan.import_id);
      const c = carryDecisions(plan, fresh, decisions);
      setPlan(fresh); setDecisions(c.decisions);
      setNotice(`${m.title} ${c.changed.length ? `${c.changed.length} ${c.changed.length === 1 ? 'appliance needs' : 'appliances need'} a fresh decision.` : 'Your decisions were kept.'}`);
      setError(null);
      setStep(fresh.review.length ? (c.changed.length ? 'review' : 'preview') : 'preview');
    } catch (e) { setError(mapBamsError(e)); } finally { setBusy(null); }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy('apply'); setError(null);
    try {
      const r = await ds.applyBamsImport(toRequest(plan, decisions));
      setResult(r); setStep('result'); bump();
      toast.push({ kind: 'success', message: `Import applied: ${r.counts.appliances_created} appliances and ${r.counts.metrics_created} metrics created` });
    } catch (e) {
      const m = mapBamsError(e);
      if (m.kind === 'applied' && m.result) { setResult(m.result); setStep('result'); bump(); }
      else if (m.kind === 'stale') await refreshAfterStale(m);
      else if (m.kind === 'unresolved') { setError(m); setStep('review'); }
      else if (m.kind === 'failed') { setError(m); setStep('result'); }
      else setError(m);
    } finally { setBusy(null); }
  };
  const goReview = () => { if (!plan) return; setError(null); if (flagged > 0) { setNotice(null); setStep('review'); } else void apply(); };
  const download = async (fmt: ImportFormat) => {
    if (!result) return;
    setBusy('skipped'); setError(null);
    try { saveFile(await ds.downloadBamsSkippedRows(result.import_id, fmt)); } catch (e) { setError(mapBamsError(e)); } finally { setBusy(null); }
  };
  const backToPreview = async () => {
    if (!plan) { startOver(); return; }
    setBusy('refresh');
    try { setPlan(await ds.getBamsImport(plan.import_id)); setError(null); setStep('preview'); } catch (e) { setError(mapBamsError(e)); } finally { setBusy(null); }
  };

  let footer;
  if (expired) footer = null;
  else if (step === 'file') {
    footer = (<><span className="muted sm">{file ? file.name : 'No file chosen'}</span><span className="bm-bar__spacer" /><Button variant="ghost" onClick={cancel}>Cancel</Button><Button variant="primary" disabled={!file || busy !== null} busy={busy === 'inspect'} busyLabel="Reading…" onClick={() => void inspect()}>Preview<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" /></Button></>);
  } else if (step === 'preview' && plan) {
    footer = (
      <>
        <Button variant="ghost" icon={<ArrowLeft size={16} strokeWidth={1.5} />} onClick={() => setStep('file')} disabled={busy !== null}>Back</Button>
        <span className="bm-bar__spacer" />
        <span className="muted sm">{plan.counts.valid === 0 ? 'No row can be imported. Fix the file and choose it again.' : flagged ? 'Apply is unlocked after step 3' : 'Nothing has been written yet.'}</span>
        <Button variant="primary" busy={busy === 'apply'} busyLabel="Applying…" disabled={plan.counts.valid === 0 || busy !== null} onClick={goReview}>{flagged ? `Review similar (${flagged})` : 'Apply import'}</Button>
      </>
    );
  } else if (step === 'review' && plan) {
    footer = (
      <>
        <Button variant="ghost" icon={<ArrowLeft size={16} strokeWidth={1.5} />} onClick={() => { setNotice(null); setStep('preview'); }} disabled={busy !== null}>Back</Button>
        <span className="bm-bar__spacer" />
        <span className={cx('sm', canApply(plan, decisions) ? 'muted' : 'bm-warning')}>{resolvedCount(plan, decisions)} of {flagged} decided</span>
        <Button variant="primary" busy={busy === 'apply'} busyLabel="Applying…" disabled={!canApply(plan, decisions) || busy !== null} aria-describedby="bm-apply-why" onClick={() => void apply()}>Apply import</Button>
      </>
    );
  }

  return (
    <div className="page bm-page bm-import">
      <nav aria-label="Breadcrumb" className="bm-crumb"><Link to="/bams">BAMS</Link><ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" /><span aria-current="page">Import appliances</span></nav>
      <PageHeader title="Import appliances and metrics" meta={`Step ${idx + 1} of 4`} />
      <ol className="bm-steps" aria-label="Import steps">
        {STEPS.map((s, i) => {
          const skipped = s.id === 'review' && plan && flagged === 0 && step !== 'review';
          return (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined} className={cx(s.id === step && 'is-on', i < idx && 'is-done', skipped && 'is-skipped')}>
              <span className="bm-steps__n" aria-hidden="true">{i < idx && !skipped ? <Check size={12} strokeWidth={2} /> : i + 1}</span>
              <span>{s.label}{i < idx ? <span className="sr-only"> (done)</span> : null}{skipped ? <span className="sr-only"> (not needed)</span> : null}</span>
            </li>
          );
        })}
      </ol>
      <div className="bm-card">
        <div className="bm-card__body">
          <h2 ref={headRef} tabIndex={-1} className="sr-only">{STEPS[idx].label}</h2>
          {expired ? (
            <div role="alert" className="banner banner--warning">
              <div className="banner__body"><b>{error!.title}</b><div className="muted sm">{error!.detail}</div></div>
              <Button size="sm" variant="primary" data-autofocus onClick={startOver}>Start over</Button>
            </div>
          ) : step === 'file' ? (
            <StepFile file={file} busy={busy === 'inspect'} error={error} onFile={(f) => { setFile(f); setError(null); }} onTemplate={(f) => void onTemplate(f)} templateBusy={templateBusy} />
          ) : step === 'preview' && plan ? (
            <>
              {error && <p role="alert" className="bm-error">{error.title} {error.detail}</p>}
              <StepPreview plan={plan} notice={notice} onChooseAnother={() => { setPlan(null); setDecisions({}); setStep('file'); }} />
            </>
          ) : step === 'review' && plan ? (
            <StepReview plan={plan} decisions={decisions} notice={notice} errorKeys={error?.kind === 'unresolved' ? error.keys ?? [] : []} error={error?.kind === 'unresolved' ? error.title : null}
              onChoose={(g, c, ref) => setDecisions((d) => choose(d, g, c, ref))} />
          ) : step === 'result' ? (
            <StepResult r={result} failure={failure} error={!failure && error ? error.title : null} onDownload={(f) => void download(f)} downloadBusy={busy === 'skipped'}
              onBackToPreview={() => void backToPreview()} onRetry={() => void apply()} onAnother={startOver} />
          ) : null}
        </div>
        {footer && <div className="bm-card__foot">{footer}</div>}
      </div>
      {step === 'review' && plan && !canApply(plan, decisions) && <p id="bm-apply-why" className="muted sm bm-why">Apply is disabled until every flagged appliance has a decision{unresolvedKeys(plan, decisions).length ? ` (${unresolvedKeys(plan, decisions).length} left)` : ''}.</p>}
      {confirmLeave && (
        <ConfirmDialog title="Discard this import?" description="Nothing has been written to your appliances. If you leave now, you will need to choose the file again." confirmLabel="Discard import" cancelLabel="Keep working" cancelVariant="primary"
          onCancel={() => setConfirmLeave(false)} onConfirm={() => { setConfirmLeave(false); navigate('/bams'); }} />
      )}
    </div>
  );
}

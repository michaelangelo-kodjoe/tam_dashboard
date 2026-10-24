import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/Fields';
import { SeverityTag } from '../../components/bams/BamsBits';
import { useToast } from '../../components/ui/Toast';
import { useApp, useData } from '../../store/DataContext';
import type { BamsAlertEvent } from '../../bamsTypes';
import { formatStamp, formatValue } from '../../lib/bams';
import { errText } from './common';

export interface CloseTarget {
  event: BamsAlertEvent;
  appliance: string;
  metric: string;
}
const MAX = 2000;

/** Close alert (mockup 04): optional note, still-breaching warning, recorded in Activity. */
export function CloseAlertDialog({ target, onClose, onClosed }: { target: CloseTarget; onClose: () => void; onClosed?: () => void }) {
  const { ds, bump } = useData();
  const { settings } = useApp();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const e = target.event;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await ds.closeBamsAlert({ id: e.id, note: note.trim() || null });
      bump();
      toast.push({ kind: 'success', message: 'Alert closed', detail: r.suppressed_until_clear ? 'It will not reopen until the value clears first.' : undefined });
      onClosed?.();
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Close alert"
      width={520}
      onClose={onClose}
      closable={!busy}
      onSubmitShortcut={() => void submit()}
      footer={
        <>
          <span className="muted sm bm-foot__hint">Recorded in Activity with your note.</span>
          <span className="bm-bar__spacer" />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" busy={busy} busyLabel="Closing…" onClick={() => void submit()}>Close alert</Button>
        </>
      }
    >
      <dl className="bm-kv">
        <dt>Appliance</dt><dd>{target.appliance}</dd>
        <dt>Metric</dt><dd>{e.message} <SeverityTag severity={e.severity} /></dd>
        <dt>Opened</dt><dd className="num">{formatStamp(e.opened_at, settings.time_display)}, peak {formatValue(e.peak_value)}</dd>
      </dl>
      {e.still_breaching && (
        <div role="alert" className="banner banner--warning">
          <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" />
          <div className="banner__body">
            <b>This metric is still breaching ({formatValue(e.current_value)}).</b> Closing will not reopen the alert until the value clears the threshold first. A new breach after that opens a fresh alert.
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="bm-close-note" className="field__label">Note (optional)</label>
        <TextArea id="bm-close-note" data-autofocus value={note} maxLength={MAX} onChange={(ev) => setNote(ev.target.value)} placeholder="Why is this being closed?" />
        <p className="field__hint num">{note.length} / {MAX}</p>
      </div>
      {error && <p role="alert" className="field__error">{error}</p>}
    </Dialog>
  );
}

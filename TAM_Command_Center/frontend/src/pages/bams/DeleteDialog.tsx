import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { SkeletonRows } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { useData, useQuery } from '../../store/DataContext';
import { errText } from './common';

/** Delete confirmation with the exact counts (mockup 06b). Blocked while any alert is open or recovered. */
export function DeleteDialog({ kind, id, rowVersion, onClose, onDeleted }: { kind: 'object' | 'metric'; id: string; rowVersion?: number; onClose: () => void; onDeleted: () => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const prev = useQuery(`bams-delprev:${kind}:${id}`, (d) => d.getBamsDeletePreview(kind, id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = prev.data;
  const noun = kind === 'object' ? 'appliance' : 'metric';
  const n = (x: number) => x.toLocaleString('en-US');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await ds.deleteBamsItem(kind, { id, expected_row_version: rowVersion });
      bump();
      toast.push({ kind: 'success', message: `${noun[0].toUpperCase()}${noun.slice(1)} deleted`, detail: p?.name });
      onDeleted();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Delete ${p?.name ?? noun}?`}
      role="alertdialog"
      width={480}
      onClose={onClose}
      closable={!busy}
      footer={
        <>
          <Button data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 size={14} strokeWidth={1.5} />} busy={busy} busyLabel="Deleting…" disabled={!p || p.blocked} onClick={() => void submit()}>Delete {noun}</Button>
        </>
      }
    >
      {prev.loading && <SkeletonRows rows={3} label="Checking what would be removed" />}
      {prev.error ? <p role="alert" className="field__error">{errText(prev.error)}</p> : null}
      {p && (
        <>
          <p>This permanently removes the {noun}{kind === 'object' ? ', its metrics, rules and history' : ' with its rules and history'}:</p>
          <ul className="bm-delcounts num">
            {kind === 'object' && <li><b>{n(p.metrics)}</b> {p.metrics === 1 ? 'metric' : 'metrics'}</li>}
            <li><b>{n(p.rules)}</b> alert {p.rules === 1 ? 'rule' : 'rules'}</li>
            <li><b>{n(p.alerts_total)}</b> alert {p.alerts_total === 1 ? 'event' : 'events'}{p.alerts_active === 0 ? ' (all closed)' : ''}</li>
            <li><b>{n(p.samples)}</b> stored samples</li>
          </ul>
          {p.blocked ? (
            <div role="alert" className="banner banner--warning"><div className="banner__body"><b>Delete is blocked.</b> {p.blocked_reason}</div></div>
          ) : (
            <p className="muted sm">A safety backup is taken first. Deletion is blocked while any alert is open or recovered. Disable the {noun} instead to keep history.</p>
          )}
        </>
      )}
      {error && <p role="alert" className="field__error">{error}</p>}
    </Dialog>
  );
}

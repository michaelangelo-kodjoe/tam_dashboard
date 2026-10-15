import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Field, TextInput } from '../../components/ui/Fields';
import { useToast } from '../../components/ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useData } from '../../store/DataContext';
import type { OpsQuarter, OpsSetVersionResult } from '../../opsTypes';

/** One-field dialog "Apply to N appliances" (D-119). Blank clears back to the quarter default. */
export function SetVersionDialog({ quarter, ids, onClose, onDone }: { quarter: OpsQuarter; ids: string[]; onClose: () => void; onDone: (r: OpsSetVersionResult) => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const [version, setVersion] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = ids.length;
  const submit = async () => {
    if (version.trim().length > 50) { setErr('Version is at most 50 characters.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await ds.setOperationsVersion({ year: quarter.year, quarter: quarter.quarter, object_ids: ids, target_version: version.trim() || null });
      bump();
      toast.push({ kind: r.skipped.length ? 'info' : 'success', message: r.message });
      onDone(r);
    } catch (e) { setErr(e instanceof DataSourceError ? e.message : 'Could not set the version. Nothing was changed.'); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title="Set version" width={460} onClose={onClose} onSubmitShortcut={submit}
      footer={<><span className="ops-spacer" /><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={submit}>{version.trim() ? 'Set version' : 'Clear version'}</Button></>}
    >
      <p className="ops-lead">Apply to <b className="num">{n}</b> {n === 1 ? 'appliance' : 'appliances'} in {quarter.label}.</p>
      <Field label="Target version" error={err ?? undefined} hint={`Leave blank to clear and follow the quarter default${quarter.target_version ? ` (${quarter.target_version})` : ''}. Status, date and note are not changed.`}>
        {(p) => <TextInput id={p.id} autoFocus maxLength={50} value={version} onChange={(e) => { setVersion(e.target.value); setErr(null); }} placeholder="e.g. 5.0.1" invalid={p.invalid} aria-describedby={p.describedBy} />}
      </Field>
    </Dialog>
  );
}

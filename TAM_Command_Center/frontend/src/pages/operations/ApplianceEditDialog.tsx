import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Select } from '../../components/ui/Select';
import { DateField, Field, TextArea, TextInput } from '../../components/ui/Fields';
import { useToast } from '../../components/ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useData } from '../../store/DataContext';
import { OPS_STATUSES, type OpsApplianceInput, type OpsQuarter, type OpsRow } from '../../opsTypes';
import type { BamsObjectInput } from '../../bamsTypes';

const ENV = [{ value: 'PROD', label: 'PROD' }, { value: 'DEV', label: 'DEV' }];
const POL = [{ value: 'East', label: 'East' }, { value: 'West', label: 'West' }];

export function statusOptions(current: string) {
  const base: string[] = [...OPS_STATUSES];
  if (!base.includes(current)) base.push(current); // legacy Validation Required / Exception stays selectable
  return base.map((s) => ({ value: s, label: s }));
}

/** Row edit (D-115): status, date override, own version, note, environment / East-West fixes, Reset to quarter. */
export function ApplianceEditDialog({ row, quarter, today, onClose }: { row: OpsRow; quarter: OpsQuarter; today: string; onClose: () => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const [status, setStatus] = useState<string | null>(row.status);
  const [date, setDate] = useState<string | null>(row.date.override);
  const [version, setVersion] = useState(row.version.own ?? '');
  const [note, setNote] = useState(row.notes ?? '');
  const [env, setEnv] = useState<string | null>(row.environment);
  const [pol, setPol] = useState<string | null>(row.polarity);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErrors({}); setFormError(null);
    try {
      const objChanged = env !== row.environment || pol !== row.polarity;
      if (objChanged) {
        const input: Partial<BamsObjectInput> & { id: string; name: string; metrics: [] } = { id: row.object_id, name: row.appliance, expected_row_version: row.object_row_version, metrics: [] };
        if (env !== row.environment) input.environment = env as 'PROD' | 'DEV' | null;
        if (pol !== row.polarity) input.region = pol;
        await ds.saveBamsObject(input as BamsObjectInput);
      }
      const input: OpsApplianceInput = { object_id: row.object_id, year: quarter.year, quarter: quarter.quarter };
      if (status && status !== row.status) input.status = status as OpsApplianceInput['status'];
      if ((date ?? null) !== row.date.override) input.date_override = date;
      if (version.trim() !== (row.version.own ?? '')) input.target_version = version.trim() || null;
      if (note.trim() !== (row.notes ?? '')) input.notes = note.trim() || null;
      if (row.record_row_version !== null) input.expected_row_version = row.record_row_version;
      if (Object.keys(input).length > 3 + (input.expected_row_version !== undefined ? 1 : 0)) await ds.saveOperationsAppliance(input);
      bump();
      toast.push({ kind: 'success', message: `${row.appliance} saved` });
      onClose();
    } catch (e) {
      if (e instanceof DataSourceError) { setErrors(e.fields ?? {}); setFormError(e.message); } else setFormError('Could not save. Nothing was changed.');
      if (e instanceof DataSourceError && e.code === 'stale_write') bump();
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setResetErr(null);
    try {
      await ds.resetOperationsAppliance({ object_id: row.object_id, year: quarter.year, quarter: quarter.quarter, confirm: true, expected_row_version: row.record_row_version ?? undefined });
      bump();
      toast.push({ kind: 'success', message: `${row.appliance} reset to ${quarter.label}` });
      onClose();
    } catch (e) { setResetErr(e instanceof DataSourceError ? e.message : 'Could not reset. Nothing was changed.'); } finally { setBusy(false); }
  };

  if (confirmReset) {
    return <ConfirmDialog title="Reset to quarter?" objectName={row.appliance} description={`Status, date override, own version and note for ${quarter.label} are removed; the appliance follows the quarter again. A backup is made first.`} confirmLabel="Reset to quarter" busy={busy} error={resetErr} onConfirm={reset} onCancel={() => setConfirmReset(false)} />;
  }
  const dateHint = row.date.derived ? `Blank follows the quarter: ${row.date.derived}` : row.date.reason ?? undefined;
  return (
    <Dialog
      title={`Edit ${row.appliance}`} width={560} onClose={onClose} onSubmitShortcut={submit}
      footer={
        <>
          {row.record_id && <Button variant="ghost" onClick={() => setConfirmReset(true)}>Reset to quarter</Button>}
          <span className="ops-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>Save</Button>
        </>
      }
    >
      <p className="ops-lead muted">{row.client_name} &middot; {quarter.label}</p>
      {formError && <p role="alert" className="field__error ops-formerr">{formError}</p>}
      <div className="ops-grid2">
        <Field label="Environment" error={errors.environment}>{(p) => <Select id={p.id} labelledBy={p.labelId} value={env} onChange={setEnv} options={ENV} clearable clearLabel="Not set" aria-invalid={p.invalid} />}</Field>
        <Field label="Polarity (East / West)" error={errors.polarity} hint={row.region && !row.polarity ? `Region currently reads "${row.region}".` : undefined}>{(p) => <Select id={p.id} labelledBy={p.labelId} value={pol} onChange={setPol} options={POL} clearable clearLabel="Not set" aria-invalid={p.invalid} />}</Field>
      </div>
      <Field label="Status" error={errors.status}>{(p) => <Select id={p.id} labelledBy={p.labelId} value={status} onChange={setStatus} options={statusOptions(row.status)} aria-invalid={p.invalid} />}</Field>
      <Field label="Date override" error={errors.date_override} hint={dateHint}>{(p) => <DateField id={p.id} value={date} onChange={setDate} today={today} invalid={p.invalid} describedBy={p.describedBy} />}</Field>
      <Field label="Target version" error={errors.target_version} hint={`Blank follows the quarter default${quarter.target_version ? ` (${quarter.target_version})` : ''}.`}>
        {(p) => <TextInput id={p.id} maxLength={50} value={version} onChange={(e) => setVersion(e.target.value)} placeholder={quarter.target_version ?? ''} invalid={p.invalid} aria-describedby={p.describedBy} />}
      </Field>
      <Field label="Note" error={errors.notes}>{(p) => <TextArea id={p.id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} invalid={p.invalid} />}</Field>
    </Dialog>
  );
}

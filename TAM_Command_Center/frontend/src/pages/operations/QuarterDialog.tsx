import { useState } from 'react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Select } from '../../components/ui/Select';
import { DateField, Field, TextInput } from '../../components/ui/Fields';
import { useToast } from '../../components/ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { enterSubmit } from './enterSubmit';
import { useData } from '../../store/DataContext';
import type { OpsQuarter, OpsQuarterName } from '../../opsTypes';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'].map((q) => ({ value: q, label: q }));
const FIELD_MAP: Record<string, string> = { apics_version: 'version', dev_upgrade_date: 'dev', east_prod_date: 'east', west_prod_date: 'west', year: 'year', quarter: 'quarter' };

/** Add / edit / delete a quarter (D-110, D-121). The Target version here applies to every appliance of the quarter. */
export function QuarterDialog({ quarter, today, onClose, onSaved, onDeleted }: {
  quarter: OpsQuarter | null; today: string; onClose: () => void; onSaved: (q: OpsQuarter) => void; onDeleted: () => void;
}) {
  const edit = !!quarter;
  const { ds, bump } = useData();
  const toast = useToast();
  const [year, setYear] = useState(String(quarter?.year ?? Number(today.slice(0, 4))));
  const [qn, setQn] = useState<string | null>(quarter?.quarter ?? 'Q' + (Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1));
  const [version, setVersion] = useState(quarter?.target_version ?? '');
  const [dev, setDev] = useState<string | null>(quarter?.dev_date ?? null);
  const [east, setEast] = useState<string | null>(quarter?.east_prod_date ?? null);
  const [west, setWest] = useState<string | null>(quarter?.west_prod_date ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  const fail = (e: unknown, set: (m: string) => void) => {
    if (e instanceof DataSourceError) {
      const f: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.fields ?? {})) f[FIELD_MAP[k] ?? k] = v;
      setErrors(f);
      set(e.code === 'validation_error' && Object.keys(f).length ? 'Fix the highlighted fields.' : e.message);
    } else set('Could not save. Nothing was changed.');
  };

  const submit = async () => {
    const local: Record<string, string> = {};
    const y = Number(year);
    if (!/^\d{4}$/.test(year.trim()) || y < 2000 || y > 2100) local.year = 'Enter a year from 2000 to 2100.';
    if (!qn) local.quarter = 'Choose a quarter.';
    if (version.trim().length > 50) local.version = 'Version is at most 50 characters.';
    if (Object.keys(local).length) { setErrors(local); setFormError('Fix the highlighted fields.'); return; }
    setBusy(true); setErrors({}); setFormError(null);
    try {
      const saved = await ds.saveOperationsQuarter({
        year: y, quarter: qn as OpsQuarterName, apics_version: version.trim() || null, dev_upgrade_date: dev, east_prod_date: east, west_prod_date: west,
        ...(quarter ? { expected_row_version: quarter.row_version } : {}),
      });
      bump();
      toast.push({ kind: 'success', message: `${saved.label} ${edit ? 'saved' : 'added'}` });
      onSaved(saved);
    } catch (e) { fail(e, setFormError); } finally { setBusy(false); }
  };

  const del = async () => {
    if (!quarter) return;
    setBusy(true); setDelError(null);
    try {
      await ds.deleteOperationsQuarter({ year: quarter.year, quarter: quarter.quarter, confirm: true, expected_row_version: quarter.row_version });
      bump();
      toast.push({ kind: 'success', message: `${quarter.label} deleted` });
      onDeleted();
    } catch (e) { setDelError(e instanceof DataSourceError ? e.message : 'Could not delete. Nothing was changed.'); } finally { setBusy(false); }
  };

  const blocked = (quarter?.records ?? 0) > 0;
  if (confirmDelete && quarter) {
    return <ConfirmDialog title="Delete quarter?" objectName={quarter.label} description="The quarter and its dates are removed. Appliances are not affected. A backup is made first." confirmLabel="Delete quarter" busy={busy} error={delError} onConfirm={del} onCancel={() => { setConfirmDelete(false); setDelError(null); }} />;
  }
  return (
    <Dialog
      title={edit ? `Edit ${quarter!.label}` : 'Add quarter'} width={560} onClose={onClose} onSubmitShortcut={submit}
      footer={
        <>
          {edit && <Button variant="danger" disabled={blocked} onClick={() => setConfirmDelete(true)}>Delete quarter</Button>}
          {blocked && <span className="muted sm ops-delnote">{quarter!.records} appliances have a status in this quarter</span>}
          <span className="ops-spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>{edit ? 'Save quarter' : 'Add quarter'}</Button>
        </>
      }
    >
      <div onKeyDown={enterSubmit(submit, busy)}>
      {formError && <p role="alert" className="field__error ops-formerr">{formError}</p>}
      <div className="ops-grid2">
        <Field label="Year" required error={errors.year}>{(p) => <TextInput id={p.id} inputMode="numeric" maxLength={4} value={year} disabled={edit} onChange={(e) => setYear(e.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}</Field>
        <Field label="Quarter" required error={errors.quarter}>{(p) => <Select id={p.id} labelledBy={p.labelId} value={qn} onChange={setQn} options={QUARTERS} disabled={edit} aria-invalid={p.invalid} />}</Field>
      </div>
      <Field label="Target version" error={errors.version} hint="Applies to every appliance in this quarter unless an appliance has its own version.">
        {(p) => <TextInput id={p.id} maxLength={50} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 4.78.0" invalid={p.invalid} aria-describedby={p.describedBy} />}
      </Field>
      <Field label="DEV date" error={errors.dev}>{(p) => <DateField id={p.id} value={dev} onChange={setDev} today={today} invalid={p.invalid} describedBy={p.describedBy} />}</Field>
      <Field label="PROD East date" error={errors.east}>{(p) => <DateField id={p.id} value={east} onChange={setEast} today={today} invalid={p.invalid} describedBy={p.describedBy} />}</Field>
      <Field label="PROD West date" error={errors.west}>{(p) => <DateField id={p.id} value={west} onChange={setWest} today={today} invalid={p.invalid} describedBy={p.describedBy} />}</Field>
      </div>
    </Dialog>
  );
}

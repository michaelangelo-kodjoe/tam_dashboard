import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Field, TextInput } from '../../components/ui/Fields';
import { Switch } from '../../components/ui/Switch';
import { SkeletonRows } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useApp, useData, useQuery } from '../../store/DataContext';
import type { BamsMetricInput } from '../../bamsTypes';
import { DeleteDialog } from './DeleteDialog';
import { errText } from './common';

interface MetricDraft { key: number; id?: string; metric_name: string; ticker: string; row_version?: number }
const ENV = [{ value: 'PROD', label: 'PROD' }, { value: 'DEV', label: 'DEV' }];
let seq = 0;
const blank = (): MetricDraft => ({ key: ++seq, metric_name: '', ticker: '' });

/** Add / edit appliance (mockup 06): account, name, region, location, environment, metrics with duplicate validation. */
export function ApplianceDialog({ objectId, defaultClientId, onClose, onDeleted }: { objectId?: string; defaultClientId?: string; onClose: () => void; onDeleted: () => void }) {
  const edit = !!objectId;
  const { accounts } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const existing = useQuery(`bams-edit:${objectId}`, (d) => d.getBamsState({ object_id: objectId, include_disabled: true, spark: false }), { enabled: edit });
  if (edit && !existing.data) return <Dialog title="Edit appliance" width={720} onClose={onClose} footer={<Button onClick={onClose}>Cancel</Button>}>{existing.error ? <p role="alert" className="field__error">{errText(existing.error)}</p> : <SkeletonRows rows={5} label="Loading appliance" />}</Dialog>;
  const rows = existing.data?.rows ?? [];
  const obj = rows[0]?.object;
  return <Form key={objectId ?? 'new'} accounts={accounts} ds={ds} bump={bump} toast={toast} obj={obj} metrics={rows.map((r) => ({ key: ++seq, id: r.id, metric_name: r.metric_name, ticker: r.ticker, row_version: r.row_version }))} defaultClientId={defaultClientId} onClose={onClose} onDeleted={onDeleted} />;
}

function Form({ accounts, ds, bump, toast, obj, metrics: initial, defaultClientId, onClose, onDeleted }: {
  accounts: ReturnType<typeof useApp>['accounts']; ds: ReturnType<typeof useData>['ds']; bump: () => void; toast: ReturnType<typeof useToast>;
  obj?: { id: string; name: string; client_id: string; region: string | null; location: string | null; environment: string | null; enabled: boolean; row_version: number };
  metrics: MetricDraft[]; defaultClientId?: string; onClose: () => void; onDeleted: () => void;
}) {
  const edit = !!obj;
  const [clientId, setClientId] = useState<string | null>(obj?.client_id ?? defaultClientId ?? null);
  const [name, setName] = useState(obj?.name ?? '');
  const [region, setRegion] = useState(obj?.region ?? '');
  const [location, setLocation] = useState(obj?.location ?? '');
  const [env, setEnv] = useState<string | null>(obj?.environment ?? null);
  const [enabled, setEnabled] = useState(obj?.enabled ?? true);
  const [ms, setMs] = useState<MetricDraft[]>(initial.length ? initial : [blank()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<null | { kind: 'object' | 'metric'; id: string; version?: number }>(null);
  const accountOpts = useMemo(() => accounts.map((a) => ({ value: a.id, label: a.name })), [accounts]);

  const touch = () => { if (Object.keys(errors).length || formError) { setErrors({}); setFormError(null); } };
  const setMetric = (key: number, patch: Partial<MetricDraft>) => { touch(); setMs((l) => l.map((m) => (m.key === key ? { ...m, ...patch } : m))); };

  const submit = async () => {
    const local: Record<string, string> = {};
    if (!clientId) local.client_id = 'Choose an account.';
    if (!name.trim()) local.name = 'Appliance name is required.';
    ms.forEach((m, i) => {
      if (!m.metric_name.trim()) local[`metrics[${i}].metric_name`] = 'Metric name is required.';
      if (!m.ticker.trim()) local[`metrics[${i}].ticker`] = 'Ticker is required.';
    });
    if (ms.length === 0) local.metrics = 'Add at least one metric.';
    if (Object.keys(local).length) { setErrors(local); return; }
    setBusy(true);
    try {
      const r = await ds.saveBamsObject({
        id: obj?.id, client_id: obj ? undefined : clientId!, name: name.trim(), region: region.trim() || null, location: location.trim() || null,
        environment: (env as 'PROD' | 'DEV' | null) ?? null, enabled, expected_row_version: obj?.row_version,
        metrics: ms.map<BamsMetricInput>((m) => ({ id: m.id, metric_name: m.metric_name.trim(), ticker: m.ticker.trim(), expected_row_version: m.row_version })),
      });
      bump();
      toast.push({ kind: 'success', message: edit ? 'Appliance saved' : 'Appliance added', detail: `${r.item.name}. New metrics show No data until the next poll.` });
      onClose();
    } catch (e) {
      if (e instanceof DataSourceError && e.fields) { setErrors(e.fields); }
      else setFormError(errText(e));
      setBusy(false);
    }
  };

  const title = edit ? 'Edit appliance' : 'Add appliance';
  const hasErr = Object.keys(errors).length > 0;
  return (
    <>
      <Dialog
        title={title}
        width={720}
        onClose={onClose}
        closable={!busy}
        closeOnScrim={false}
        onSubmitShortcut={() => void submit()}
        footer={
          <>
            {edit && <Button variant="ghost" icon={<Trash2 size={14} strokeWidth={1.5} />} onClick={() => setDeleting({ kind: 'object', id: obj!.id, version: obj!.row_version })} disabled={busy}>Delete appliance</Button>}
            <span className="bm-bar__spacer" />
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" busy={busy} busyLabel="Saving…" disabled={hasErr && !busy} aria-disabled={hasErr || undefined} onClick={() => void submit()}>Save appliance</Button>
          </>
        }
      >
        <div className="bm-form2">
          <Field label="Account" required error={errors.client_id}>
            {(f) => <Select id={f.id} labelledBy={f.labelId} value={clientId} options={accountOpts} onChange={(v) => { touch(); setClientId(v); }} placeholder="Choose an account" disabled={edit} aria-invalid={f.invalid} aria-describedby={f.describedBy} />}
          </Field>
          <Field label="Appliance name" required error={errors.name}>
            {(f) => <TextInput id={f.id} value={name} maxLength={200} data-autofocus={!edit || undefined} invalid={f.invalid} aria-describedby={f.describedBy} onChange={(e) => { touch(); setName(e.target.value); }} />}
          </Field>
          <Field label="Region" error={errors.region}>
            {(f) => <TextInput id={f.id} value={region} maxLength={100} onChange={(e) => { touch(); setRegion(e.target.value); }} />}
          </Field>
          <Field label="Location" error={errors.location}>
            {(f) => <TextInput id={f.id} value={location} maxLength={200} onChange={(e) => { touch(); setLocation(e.target.value); }} />}
          </Field>
          <Field label="Environment">
            {(f) => <Select id={f.id} labelledBy={f.labelId} value={env} options={ENV} onChange={setEnv} clearable clearLabel="Not set" placeholder="Not set" />}
          </Field>
          {edit && (
            <div className="field"><span className="field__label">Monitoring</span><Switch checked={enabled} onChange={setEnabled} label={enabled ? 'Enabled' : 'Disabled (excluded from counts)'} /></div>
          )}
        </div>
        <div className="label bm-metrics__label">Metrics (at least one)</div>
        <div className="bm-metrics" role="group" aria-label="Metrics">
          <div className="bm-metrics__head" aria-hidden="true"><span>Metric name</span><span>Bloomberg ticker (unique)</span><span /></div>
          {ms.map((m, i) => (
            <div key={m.key} className="bm-metrics__row">
              <div className="field">
                <TextInput aria-label={`Metric ${i + 1} name`} value={m.metric_name} maxLength={200} invalid={!!errors[`metrics[${i}].metric_name`]} onChange={(e) => setMetric(m.key, { metric_name: e.target.value })} className="input--sm" />
                {errors[`metrics[${i}].metric_name`] && <p className="field__error">{errors[`metrics[${i}].metric_name`]}</p>}
              </div>
              <div className="field">
                <TextInput aria-label={`Metric ${i + 1} ticker`} className="mono input--sm" value={m.ticker} maxLength={200} invalid={!!errors[`metrics[${i}].ticker`]} onChange={(e) => setMetric(m.key, { ticker: e.target.value })} />
                {errors[`metrics[${i}].ticker`] && <p className="field__error">{errors[`metrics[${i}].ticker`]}</p>}
              </div>
              <Button variant="icon" size="sm" aria-label={`Remove metric ${i + 1}`} title={m.id ? 'Delete metric' : 'Remove metric'} icon={<Trash2 size={14} strokeWidth={1.5} />}
                disabled={ms.length === 1 && !m.id}
                onClick={() => (m.id ? setDeleting({ kind: 'metric', id: m.id, version: m.row_version }) : (touch(), setMs((l) => l.filter((x) => x.key !== m.key))))} />
            </div>
          ))}
        </div>
        {errors.metrics && <p className="field__error">{errors.metrics}</p>}
        <Button size="sm" icon={<Plus size={14} strokeWidth={1.5} />} onClick={() => { touch(); setMs((l) => [...l, blank()]); }}>Add metric</Button>
        {formError && <p role="alert" className="field__error bm-formerr">{formError}</p>}
      </Dialog>
      {deleting && (
        <DeleteDialog kind={deleting.kind} id={deleting.id} rowVersion={deleting.version} onClose={() => setDeleting(null)}
          onDeleted={() => { const d = deleting; setDeleting(null); if (d.kind === 'object') onDeleted(); else { setMs((l) => l.filter((x) => x.id !== d.id)); } }} />
      )}
    </>
  );
}

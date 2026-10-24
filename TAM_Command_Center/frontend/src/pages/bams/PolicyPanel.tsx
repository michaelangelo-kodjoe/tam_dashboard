import { useMemo, useState } from 'react';
import { Layers } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Select, type SelectOption } from '../../components/ui/Select';
import { Field, TextInput } from '../../components/ui/Fields';
import { Switch } from '../../components/ui/Switch';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SkeletonRows } from '../../components/ui/Feedback';
import { SeverityTag } from '../../components/bams/BamsBits';
import { useData, useQuery } from '../../store/DataContext';
import { cx } from '../../lib/cx';
import { EMPTY_FORM, OPERATOR_GLYPH, OPERATOR_TEXT, buildPolicyInput, exactMetric, formFromPolicy, isPattern, previewText, scopeText, type PolicyForm } from '../../lib/bamsPolicy';
import type { BamsConfig, Operator, Severity } from '../../bamsTypes';
import { DataSourceError } from '../../data/DataSource';
import { errText } from './common';

const OPERATORS = Object.keys(OPERATOR_TEXT) as Operator[];
const SEVERITIES: Severity[] = ['Info', 'Warning', 'Critical'];

/** Metric-first alert policies: define the condition once; every enabled appliance carrying the metric inherits it, now and later. */
export function PolicyPanel() {
  const { ds, bump } = useData();
  const catalog = useQuery('bams-metric-catalog', (d) => d.getBamsMetricCatalog());
  const configs = useQuery('bams-configs', (d) => d.getBamsConfigs());
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<BamsConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deleting, setDeleting] = useState<BamsConfig | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  const cat = catalog.data ?? [];
  const policies = (configs.data ?? []).filter((p) => p.auto_apply);
  const metric = exactMetric(cat, form.metric);
  const set = (p: Partial<PolicyForm>) => { setForm((f) => ({ ...f, ...p })); setError(''); };
  const options = useMemo<SelectOption[]>(() => cat.map((m) => ({ value: m.metric_name, label: m.metric_name })), [cat]);
  const countOf = (name: string) => cat.find((m) => m.metric_name === name)?.appliance_count;
  const patternEdit = !!editing && isPattern(editing.metric_match);
  const consecutive = Number(form.consecutive) || 1;
  const refresh = () => { configs.reload(); catalog.reload(); bump(); };

  const save = async () => {
    if (saving) return;
    setError(''); setSuccess('');
    const r = buildPolicyInput(form, cat, editing);
    if ('error' in r) { setError(r.error); return; }
    setSaving(true);
    try {
      await ds.saveBamsConfig(r.body);
      const n = r.metric.appliance_count;
      setSuccess(`${r.metric.metric_name} policy ${editing ? 'updated' : 'saved'}. It now applies to ${n} ${n === 1 ? 'appliance' : 'appliances'} and will inherit to future matching appliances.`);
      setEditing(null); setForm(EMPTY_FORM);
      refresh();
    } catch (e) {
      setError(e instanceof DataSourceError && e.fields ? String(Object.values(e.fields)[0]) : errText(e, 'Could not save the metric policy.'));
    } finally { setSaving(false); }
  };
  const toggle = async (p: BamsConfig) => {
    setError(''); setSuccess('');
    try {
      await ds.saveBamsConfig({ id: p.id, expected_row_version: p.row_version, enabled: !p.enabled, auto_apply: true });
      setSuccess(`${p.metric_match} policy ${p.enabled ? 'disabled' : 'enabled'}.`);
      refresh();
    } catch (e) { setError(errText(e, 'The metric policy action failed.')); }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await ds.deleteBamsConfig({ id: deleting.id });
      setSuccess(`${deleting.metric_match} policy deleted. Existing managed rules were disabled; alert history was preserved.`);
      if (editing?.id === deleting.id) { setEditing(null); setForm(EMPTY_FORM); }
      setDeleting(null); setDelError(null);
      refresh();
    } catch (e) { setDelError(errText(e)); }
  };
  const edit = (p: BamsConfig) => { setEditing(p); setForm(formFromPolicy(p)); setSuccess(''); setError(''); };
  const cancelEdit = () => { setEditing(null); setForm(EMPTY_FORM); setError(''); };

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <div className="map-head">
        <div>
          <div className="label">Global metric policies</div>
          <h2 id="map-title" className="map-title">Apply alerts by metric</h2>
          <p className="muted sm">Define the condition once. Every enabled appliance carrying that metric inherits the rule now and in the future.</p>
        </div>
        <div className="map-head__right">
          <span className="map-count num">{policies.length} active {policies.length === 1 ? 'policy' : 'policies'}</span>
        </div>
      </div>
      {error && <div className="banner banner--danger map-banner" role="alert"><div className="banner__body">{error}</div></div>}
      {success && <div className="banner bm-okbanner map-banner" role="status"><div className="banner__body">{success}</div></div>}

      <div className="map-workbench">
        <form className="map-form" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <div className="map-form__title">
            <span>{editing ? 'Edit metric policy' : 'New metric policy'}</span>
            {editing && <button type="button" className="map-link" onClick={cancelEdit}>Cancel edit</button>}
          </div>
          <div className="map-wide">
            <Field label="Metric" hint={scopeText(metric, form.metric)}>
              {(f) => (
                <Select id={f.id} labelledBy={f.labelId} aria-describedby={f.describedBy} value={form.metric || null} options={options} placeholder={catalog.loading ? 'Loading metrics…' : 'Select a metric'}
                  disabled={patternEdit || catalog.loading} onChange={(v) => set({ metric: v ?? '' })}
                  renderValue={(o) => <span className="map-metricopt"><span>{o.label}</span><small className="muted">{countOf(o.value) ?? ''} {countOf(o.value) === 1 ? 'appliance' : 'appliances'}</small></span>} />
              )}
            </Field>
          </div>
          <fieldset className="map-direction map-wide">
            <legend className="field__label">Alert when</legend>
            <div className="map-direction__grid">
              {OPERATORS.map((o) => (
                <label key={o} className={cx('map-direction__option', form.operator === o && 'is-on')}>
                  <input type="radio" name="map-operator" value={o} checked={form.operator === o} onChange={() => set({ operator: o })} />
                  <span className="map-direction__glyph" aria-hidden="true">{OPERATOR_GLYPH[o]}</span>
                  <span><b>{OPERATOR_TEXT[o]}</b><small>{o}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Threshold">{(f) => <TextInput id={f.id} className="num" type="number" step="any" inputMode="decimal" placeholder="90" value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} />}</Field>
          <Field label="Severity">{(f) => <Select id={f.id} labelledBy={f.labelId} value={form.severity} options={SEVERITIES.map((s) => ({ value: s, label: s }))} onChange={(v) => v && set({ severity: v as Severity })} />}</Field>
          <Field label="Consecutive updates">{(f) => <TextInput id={f.id} className="num" type="number" min={1} step={1} value={form.consecutive} onChange={(e) => set({ consecutive: e.target.value })} />}</Field>
          <Field label="Cooldown (minutes)">{(f) => <TextInput id={f.id} className="num" type="number" min={0} step={1} value={form.cooldown} onChange={(e) => set({ cooldown: e.target.value })} />}</Field>
          <div className="map-wide"><Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Policy enabled" /></div>
          <div className="map-preview map-wide" aria-live="polite">
            <span className="label">Policy preview</span>
            <strong>{previewText(form.metric, form.operator, form.threshold, form.severity, consecutive)}</strong>
            <small className="muted">Scope: {scopeText(metric, form.metric)}. New matching appliances inherit automatically.</small>
          </div>
          <div className="map-form__actions map-wide">
            <Button type="submit" variant="primary" busy={saving} busyLabel="Saving…">{editing ? 'Update policy' : 'Save & apply to all appliances'}</Button>
          </div>
        </form>
        <aside className="map-inheritance" aria-label="How metric policies inherit">
          <div className="map-inheritance__title">Inheritance</div>
          <ol className="map-rail">
            <li><span aria-hidden="true">1</span><div><b>Select one metric</b><small>Example: CPU Utilization</small></div></li>
            <li><span aria-hidden="true">2</span><div><b>Set its own condition</b><small>CPU can be high; memory can be low.</small></div></li>
            <li><span aria-hidden="true">3</span><div><b>Apply everywhere</b><small>Current and future appliances inherit it.</small></div></li>
          </ol>
          <div className="map-example">
            <div><span>CPU Utilization</span><b className="map-up">↑ &gt; 90</b></div>
            <div><span>Memory Available</span><b className="map-down">↓ &lt; 15</b></div>
          </div>
        </aside>
      </div>

      <div className="map-policies">
        <div className="map-policies__head">
          <div><div className="label">Managed policies</div><h3 className="map-sub">Inherited across appliances</h3></div>
          <Button size="sm" onClick={refresh}>Refresh</Button>
        </div>
        {configs.loading ? <SkeletonRows rows={2} label="Loading metric policies" /> : policies.length === 0 ? (
          <div className="map-empty"><Layers size={16} strokeWidth={1.5} aria-hidden="true" /> No persistent metric policies yet. Create one above.</div>
        ) : (
          <div className="table-scroll bm-tbl bm-tbl--wrap">
            <table className="table table--compact">
              <caption className="sr-only">Persistent metric policies</caption>
              <thead><tr><th scope="col">Metric</th><th scope="col">Condition</th><th scope="col">Severity</th><th scope="col">Scope</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {policies.map((p) => {
                  const pattern = isPattern(p.metric_match);
                  const m = exactMetric(cat, p.metric_match);
                  const scope = m ? `${m.appliance_count} appliances` : pattern ? `${p.matches} matching metrics` : `${p.matches} appliances`;
                  return (
                    <tr key={p.id}>
                      <td><b>{p.metric_match}</b><span className="map-subline">{pattern ? 'Advanced pattern' : 'Exact metric'}</span></td>
                      <td><span className={cx('map-condition', p.operator.startsWith('<') ? 'is-low' : 'is-high')}><b aria-hidden="true">{OPERATOR_GLYPH[p.operator]}</b>{OPERATOR_TEXT[p.operator]} {p.threshold ?? '—'}</span></td>
                      <td><SeverityTag severity={p.severity} /></td>
                      <td className="num">{scope}</td>
                      <td><span className={cx('badge', p.enabled ? 'badge--success' : 'badge--neutral')}>{p.enabled ? 'Auto-applies' : 'Disabled'}</span></td>
                      <td className="bm-actions">
                        {!pattern && <Button variant="ghost" size="sm" aria-label={`Edit policy ${p.metric_match}`} onClick={() => edit(p)}>Edit</Button>}
                        <Button variant="ghost" size="sm" aria-label={`${p.enabled ? 'Disable' : 'Enable'} policy ${p.metric_match}`} onClick={() => void toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                        <Button variant="ghost" size="sm" aria-label={`Delete policy ${p.metric_match}`} onClick={() => { setDelError(null); setDeleting(p); }}>Delete</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deleting && (
        <ConfirmDialog title="Delete this metric policy?" objectName={deleting.metric_match} confirmLabel="Delete policy" error={delError} onCancel={() => setDeleting(null)} onConfirm={() => void remove()}
          description="Managed rules will be disabled and alert history will be kept." />
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Field, TextInput } from '../../components/ui/Fields';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Switch } from '../../components/ui/Switch';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { SeverityTag } from '../../components/bams/BamsBits';
import { DataSourceError } from '../../data/DataSource';
import { useData, useQuery } from '../../store/DataContext';
import { useDocumentTitle } from '../../lib/hooks';
import { OPERATOR_LABEL, PERIOD_LABEL, RULE_TYPE_LABEL, ruleCondition, rulePreview } from '../../lib/bams';
import { cx } from '../../lib/cx';
import type { BamsConfig, BamsConfigPreview, BamsRow, BamsRule, Operator, ReferencePeriod, RuleType, Severity } from '../../bamsTypes';
import { errText } from './common';

const SEVERITIES: Severity[] = ['Info', 'Warning', 'Critical'];
interface Draft { rule_type: RuleType; operator: Operator; threshold: string; reference_period: ReferencePeriod | null; consecutive_updates: string; severity: Severity; cooldown_minutes: string; enabled: boolean; suppress_until_clear: boolean }
const NEW_DRAFT: Draft = { rule_type: 'fixed_threshold', operator: '>', threshold: '', reference_period: null, consecutive_updates: '1', severity: 'Warning', cooldown_minutes: '15', enabled: true, suppress_until_clear: false };
const toDraft = (r: BamsRule): Draft => ({
  rule_type: r.rule_type, operator: r.operator, threshold: r.threshold == null ? '' : String(r.threshold), reference_period: r.reference_period, consecutive_updates: String(r.consecutive_updates),
  severity: r.severity, cooldown_minutes: String(r.cooldown_minutes), enabled: r.enabled, suppress_until_clear: r.suppress_until_clear,
});
const num = (s: string): number | null => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));

/** Alert configuration (mockup 05): rules per metric, one editor for the three rule types, starter templates with explicit apply. */
export function ConfigPage() {
  useDocumentTitle('BAMS alert configuration');
  const [sp, setSp] = useSearchParams();
  const { ds, bump } = useData();
  const toast = useToast();
  const list = useQuery('bams-config-metrics', (d) => d.getBamsState({ spark: false, sort: 'appliance' }));
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => (list.data?.rows ?? []).filter((r) => `${r.object.name} ${r.metric_name} ${r.object.client_name}`.toLowerCase().includes(filter.trim().toLowerCase())), [list.data, filter]);
  const selectedId = sp.get('metric') ?? list.data?.rows[0]?.id ?? null;
  const detail = useQuery(`bams-config-detail:${selectedId}`, (d) => d.getBamsMetric(selectedId!), { enabled: !!selectedId });
  const [editing, setEditing] = useState<null | { id?: string; version?: number }>(null);
  const [deleting, setDeleting] = useState<BamsRule | null>(null);
  const [delError, setDelError] = useState<string | null>(null);
  const configs = useQuery('bams-configs', (d) => d.getBamsConfigs());
  useEffect(() => { setEditing(null); }, [selectedId]);

  const select = (id: string) => { const n = new URLSearchParams(sp); n.set('metric', id); setSp(n, { replace: true }); };
  const row = detail.data?.row;
  const toggle = async (r: BamsRule) => {
    try {
      await ds.saveBamsRule({ ...ruleInput(r), enabled: !r.enabled, expected_row_version: r.row_version });
      bump();
    } catch (e) { toast.push({ kind: 'error', message: 'Could not change the rule.', detail: errText(e) }); }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await ds.deleteBamsRule({ id: deleting.id, expected_row_version: deleting.row_version });
      bump();
      toast.push({ kind: 'success', message: 'Rule deleted' });
      setDeleting(null); setDelError(null);
    } catch (e) { setDelError(errText(e)); }
  };

  return (
    <div className="page bm-page">
      <PageHeader title="Alert configuration" meta="Rules per metric" actions={<Link to="/bams" className="btn btn--ghost btn--md"><span className="btn__label">Back to dashboard</span></Link>} />
      {list.loading && <SkeletonRows rows={6} label="Loading metrics" />}
      {list.error ? <ErrorBanner error={list.error} onRetry={list.reload} title="Could not load metrics" /> : null}
      {list.data && list.data.rows.length === 0 && <Panel><p className="bm-empty muted">There are no monitored metrics yet. Add an appliance first.</p></Panel>}
      {list.data && list.data.rows.length > 0 && (
        <div className="bm-split">
          <Panel title="Metrics" className="bm-metriclist">
            <label className="bm-search bm-search--block"><Search size={14} strokeWidth={1.5} aria-hidden="true" /><input className="bm-search__input" type="search" aria-label="Filter metrics" placeholder="Filter metrics" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
            <ul className="bm-metricnav" aria-label="Metrics">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" className={cx('bm-metricnav__item', r.id === selectedId && 'is-on')} aria-current={r.id === selectedId ? 'true' : undefined} onClick={() => select(r.id)}>
                    <span className="bm-metricnav__name">{r.metric_name}</span>
                    <span className="muted sm">{r.object.name}</span>
                  </button>
                </li>
              ))}
              {rows.length === 0 && <li className="muted sm bm-metricnav__none">No metric matches.</li>}
            </ul>
          </Panel>
          <div className="bm-stack">
            <Panel
              title={row ? `${row.object.name} · ${row.metric_name}` : 'Rules'}
              count={detail.data?.rules.length ?? null}
              actions={<Button variant="primary" size="sm" icon={<Plus size={14} strokeWidth={1.5} />} disabled={!row} onClick={() => setEditing({})}>New rule</Button>}
              bodyClassName="bm-tablebody"
            >
              {detail.loading && <SkeletonRows rows={3} label="Loading rules" />}
              {detail.error ? <ErrorBanner error={detail.error} onRetry={detail.reload} title="Could not load rules" /> : null}
              {detail.data && (detail.data.rules.length === 0 ? (
                <p className="bm-empty muted">No rules on this metric. Add one, or apply a starter template below.</p>
              ) : (
                <div className="table-scroll bm-tbl bm-tbl--wrap">
                  <table className="table table--compact">
                    <caption className="sr-only">Rules on this metric</caption>
                    <thead><tr><th scope="col">Type</th><th scope="col">Condition</th><th scope="col">Severity</th><th scope="col" className="is-right">Updates</th><th scope="col" className="is-right">Cooldown</th><th scope="col">Enabled</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {detail.data.rules.map((r) => (
                        <tr key={r.id} className={cx(editing?.id === r.id && 'is-highlight')}>
                          <td>{RULE_TYPE_LABEL[r.rule_type]}</td>
                          <td className="num">{ruleCondition(r)}</td>
                          <td><SeverityTag severity={r.severity} /></td>
                          <td className="is-right num">{r.consecutive_updates}</td>
                          <td className="is-right num">{r.cooldown_minutes} m</td>
                          <td><Switch checked={r.enabled} onChange={() => void toggle(r)} aria-label={`Enabled: ${ruleCondition(r)}`} /></td>
                          <td className="bm-actions">
                            <Button variant="icon" size="sm" aria-label={`Edit rule ${ruleCondition(r)}`} title="Edit rule" icon={<Pencil size={14} strokeWidth={1.5} />} onClick={() => setEditing({ id: r.id, version: r.row_version })} />
                            <Button variant="icon" size="sm" aria-label={`Delete rule ${ruleCondition(r)}`} title="Delete rule" icon={<Trash2 size={14} strokeWidth={1.5} />} onClick={() => { setDelError(null); setDeleting(r); }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Panel>
            {editing && row && detail.data && (
              <RuleEditor key={editing.id ?? 'new'} row={row} rule={detail.data.rules.find((r) => r.id === editing.id)} onCancel={() => setEditing(null)}
                onSaved={() => { setEditing(null); bump(); toast.push({ kind: 'success', message: 'Rule saved' }); }} />
            )}
            <Templates configs={configs.data ?? []} loading={configs.loading} error={configs.error} reload={configs.reload} />
          </div>
        </div>
      )}
      {deleting && (
        <ConfirmDialog title="Delete this rule?" objectName={ruleCondition(deleting)} confirmLabel="Delete rule" error={delError} onCancel={() => setDeleting(null)} onConfirm={() => void remove()}
          description="An open or recovered alert on this metric must be closed first. Closed alerts keep their history." />
      )}
    </div>
  );
}

function ruleInput(r: BamsRule) {
  return { id: r.id, rule_type: r.rule_type, operator: r.operator, threshold: r.threshold, reference_period: r.reference_period, consecutive_updates: r.consecutive_updates, severity: r.severity, cooldown_minutes: r.cooldown_minutes, enabled: r.enabled, suppress_until_clear: r.suppress_until_clear };
}

function RuleEditor({ row, rule, onCancel, onSaved }: { row: BamsRow; rule?: BamsRule; onCancel: () => void; onSaved: () => void }) {
  const { ds } = useData();
  const [d, setD] = useState<Draft>(rule ? toDraft(rule) : NEW_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setErrors({}); setFormError(null); };
  const setType = (t: RuleType) => set({
    rule_type: t,
    reference_period: t === 'fixed_threshold' ? null : d.reference_period ?? '90d',
    threshold: t === 'exceeds_high' ? '' : t === 'pct_of_high' && d.rule_type !== 'pct_of_high' ? '90' : d.threshold,
    operator: t === 'exceeds_high' && !(d.operator === '>' || d.operator === '>=') ? '>' : d.operator,
  });
  const thr = num(d.threshold);
  const cu = Number.isInteger(num(d.consecutive_updates)) ? (num(d.consecutive_updates) as number) : 0;
  const preview = rulePreview(row.metric_name, { rule_type: d.rule_type, operator: d.operator, threshold: d.rule_type === 'exceeds_high' ? null : thr, reference_period: d.reference_period, consecutive_updates: cu || 1, severity: d.severity }, row.highs);
  const hasHigh = d.rule_type !== 'fixed_threshold';
  const opOptions = (d.rule_type === 'exceeds_high' ? (['>', '>='] as Operator[]) : (['>', '>=', '<', '<='] as Operator[])).map((o) => ({ value: o, label: OPERATOR_LABEL[o] }));

  const save = async () => {
    setBusy(true);
    try {
      await ds.saveBamsRule({
        id: rule?.id, metric_id: rule ? undefined : row.id, rule_type: d.rule_type, operator: d.operator, threshold: d.rule_type === 'exceeds_high' ? null : thr,
        reference_period: d.rule_type === 'fixed_threshold' ? null : d.reference_period, consecutive_updates: cu, severity: d.severity, cooldown_minutes: num(d.cooldown_minutes) ?? -1,
        enabled: d.enabled, suppress_until_clear: d.suppress_until_clear, expected_row_version: rule?.row_version,
      });
      onSaved();
    } catch (e) {
      if (e instanceof DataSourceError && e.fields) setErrors(e.fields); else setFormError(errText(e));
      setBusy(false);
    }
  };

  return (
    <Panel title={rule ? 'Edit rule' : 'New rule'} actions={rule ? <span className="badge badge--neutral">row version {rule.row_version}</span> : undefined}>
      <form className="bm-ruleform" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <div className="field">
          <span className="field__label" id="bm-rt">Rule type</span>
          <SegmentedControl label="Rule type" value={d.rule_type} onChange={setType} options={(Object.keys(RULE_TYPE_LABEL) as RuleType[]).map((t) => ({ value: t, label: RULE_TYPE_LABEL[t] }))} />
          <p className="field__hint">{d.rule_type === 'pct_of_high' ? 'The threshold is a percentage of the period high. Values are percentages.' : d.rule_type === 'exceeds_high' ? 'Fires when the value exceeds the highest value seen in the period.' : 'Fires when the value crosses a fixed level.'}</p>
        </div>
        <div className="bm-form3">
          <Field label="Operator" error={errors.operator}>{(f) => <Select id={f.id} labelledBy={f.labelId} value={d.operator} options={opOptions} onChange={(v) => v && set({ operator: v as Operator })} />}</Field>
          {d.rule_type !== 'exceeds_high' && (
            <Field label={d.rule_type === 'pct_of_high' ? 'Threshold (% of high)' : 'Threshold (%)'} required error={errors.threshold}>
              {(f) => <TextInput id={f.id} className="num" inputMode="decimal" value={d.threshold} invalid={f.invalid} aria-describedby={f.describedBy} onChange={(e) => set({ threshold: e.target.value })} />}
            </Field>
          )}
          {hasHigh && (
            <Field label="Reference period" error={errors.reference_period}>
              {(f) => <Select id={f.id} labelledBy={f.labelId} value={d.reference_period} options={(Object.keys(PERIOD_LABEL) as ReferencePeriod[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} onChange={(v) => set({ reference_period: v as ReferencePeriod | null })} />}
            </Field>
          )}
          <Field label="Severity">{(f) => <Select id={f.id} labelledBy={f.labelId} value={d.severity} options={SEVERITIES.map((s) => ({ value: s, label: s }))} onChange={(v) => v && set({ severity: v as Severity })} />}</Field>
          <Field label="Consecutive updates" required error={errors.consecutive_updates}>{(f) => <TextInput id={f.id} className="num" inputMode="numeric" value={d.consecutive_updates} invalid={f.invalid} aria-describedby={f.describedBy} onChange={(e) => set({ consecutive_updates: e.target.value })} />}</Field>
          <Field label="Cooldown (minutes)" error={errors.cooldown_minutes}>{(f) => <TextInput id={f.id} className="num" inputMode="numeric" value={d.cooldown_minutes} invalid={f.invalid} aria-describedby={f.describedBy} onChange={(e) => set({ cooldown_minutes: e.target.value })} />}</Field>
        </div>
        <div className="bm-switches">
          <Switch checked={d.enabled} onChange={(v) => set({ enabled: v })} label="Rule enabled" />
          <Switch checked={d.suppress_until_clear} onChange={(v) => set({ suppress_until_clear: v })} label="Suppress until clear" />
        </div>
        <div className="banner banner--info bm-preview" aria-live="polite"><div className="banner__body"><span className="label">Preview</span><div>{preview}</div></div></div>
        {formError && <p role="alert" className="field__error">{formError}</p>}
        <div className="bm-ruleform__foot">
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} busyLabel="Saving…">Save rule</Button>
        </div>
      </form>
    </Panel>
  );
}

function Templates({ configs, loading, error, reload }: { configs: BamsConfig[]; loading: boolean; error: unknown; reload: () => void }) {
  const { ds, bump } = useData();
  const toast = useToast();
  const [plan, setPlan] = useState<{ config: BamsConfig; preview: BamsConfigPreview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const preview = async (c: BamsConfig) => {
    setBusy(c.id); setErr(null);
    try { setPlan({ config: c, preview: await ds.previewBamsConfig({ config_id: c.id }) }); }
    catch (e) { setErr(errText(e)); setPlan(null); }
    finally { setBusy(null); }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy('apply'); setErr(null);
    try {
      const r = await ds.applyBamsConfig({ config_id: plan.config.id, plan_hash: plan.preview.plan_hash });
      bump();
      toast.push({ kind: 'success', message: `${r.created} ${r.created === 1 ? 'rule' : 'rules'} created`, detail: r.skipped_identical ? `${r.skipped_identical} identical skipped.` : undefined });
      setPlan(null);
    } catch (e) {
      if (e instanceof DataSourceError && e.code === 'preview_stale') { setErr('Metrics or rules changed since the preview. Preview again to see the current plan.'); setPlan(null); }
      else setErr(errText(e));
    } finally { setBusy(null); }
  };
  const affected = plan ? [...new Set(plan.preview.metrics.filter((m) => m.action === 'create').map((m) => m.object_name))] : [];

  return (
    <Panel title="Starter templates" actions={<span className="muted sm">Applying is explicit. Nothing is written silently.</span>} bodyClassName="bm-tablebody">
      {loading && <SkeletonRows rows={2} label="Loading templates" />}
      {error ? <ErrorBanner error={error} onRetry={reload} title="Could not load templates" /> : null}
      {configs.length > 0 && (
        <div className="table-scroll bm-tbl bm-tbl--wrap">
          <table className="table table--compact">
            <caption className="sr-only">Starter templates</caption>
            <thead><tr><th scope="col">Template</th><th scope="col">Matches (metric name)</th><th scope="col">Rule</th><th scope="col" className="is-right">Metrics</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono">{c.metric_match}</td>
                  <td>{c.preview.replace(/^Alerts when a matching metric /, '')}</td>
                  <td className="is-right num">{c.matches}</td>
                  <td><Button size="sm" busy={busy === c.id} busyLabel="Checking…" onClick={() => void preview(c)} aria-label={`Preview and apply ${c.name}`}>Preview and apply</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(plan || err) && (
        <div className="bm-applybox">
          {err && <p role="alert" className="field__error">{err}</p>}
          {plan && (
            <>
              <div role="status" className="banner banner--warning">
                <div className="banner__body">
                  <b>Apply preview: {plan.config.name}.</b>{' '}
                  {plan.preview.would_create === 0
                    ? `Nothing to add; ${plan.preview.skipped_identical} ${plan.preview.skipped_identical === 1 ? 'metric already has' : 'metrics already have'} an identical rule.`
                    : `Adds ${plan.preview.would_create} new ${plan.preview.would_create === 1 ? 'rule' : 'rules'}${plan.preview.skipped_identical ? `; ${plan.preview.skipped_identical} ${plan.preview.skipped_identical === 1 ? 'metric already has' : 'metrics already have'} an identical rule and ${plan.preview.skipped_identical === 1 ? 'is' : 'are'} skipped` : ''}. Affected: ${affected.join(', ')}.`}
                </div>
              </div>
              <div className="bm-applybox__btns">
                <Button variant="primary" size="sm" busy={busy === 'apply'} busyLabel="Applying…" disabled={plan.preview.would_create === 0} onClick={() => void apply()}>Apply to {plan.preview.would_create} {plan.preview.would_create === 1 ? 'metric' : 'metrics'}</Button>
                <Button variant="ghost" size="sm" onClick={() => setPlan(null)}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

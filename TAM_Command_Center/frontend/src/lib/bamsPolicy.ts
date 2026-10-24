// Metric-first persistent alert policies (BACKPORT_GAP: metric-alert-policies.js, ported to React).
import type { BamsConfig, BamsConfigInput, BamsMetricCatalogItem, Operator, Severity } from '../bamsTypes';

export const OPERATOR_TEXT: Record<Operator, string> = { '>': 'Above threshold', '>=': 'At or above threshold', '<': 'Below threshold', '<=': 'At or below threshold' };
export const OPERATOR_GLYPH: Record<Operator, string> = { '>': '↑', '>=': '↑', '<': '↓', '<=': '↓' };
export const isPattern = (v: string): boolean => /[*?[]/.test(v);

export function exactMetric(catalog: BamsMetricCatalogItem[], name: string): BamsMetricCatalogItem | null {
  const q = name.trim().toLowerCase();
  return catalog.find((m) => m.metric_name.toLowerCase() === q) ?? null;
}

export const scopeText = (m: BamsMetricCatalogItem | null, metric: string): string =>
  m ? `${m.appliance_count} ${m.appliance_count === 1 ? 'appliance' : 'appliances'} · ${m.account_count} ${m.account_count === 1 ? 'account' : 'accounts'}`
    : metric ? 'Choose an exact metric from the catalog.' : 'Select a metric to see its scope.';

export const policyName = (metric: string, op: Operator, threshold: number, severity: Severity): string => `${metric} · ${op} ${threshold} · ${severity}`;

export function previewText(metric: string, op: Operator, threshold: string, severity: Severity, consecutive: number): string {
  return metric && threshold !== '' ? `${metric} ${op} ${threshold} · ${severity} · ${consecutive} ${consecutive === 1 ? 'update' : 'updates'}` : 'Choose a metric, condition and threshold.';
}

export interface PolicyForm { metric: string; operator: Operator; threshold: string; severity: Severity; consecutive: string; cooldown: string; enabled: boolean }
export const EMPTY_FORM: PolicyForm = { metric: '', operator: '>', threshold: '', severity: 'Warning', consecutive: '1', cooldown: '15', enabled: true };
export const formFromPolicy = (p: BamsConfig): PolicyForm => ({
  metric: p.metric_match, operator: p.operator, threshold: p.threshold == null ? '' : String(p.threshold), severity: p.severity,
  consecutive: String(p.consecutive_updates), cooldown: String(p.cooldown_minutes), enabled: p.enabled,
});

/** Validate and build the save body. Returns the first error text instead of a body when the form is not valid. */
export function buildPolicyInput(f: PolicyForm, catalog: BamsMetricCatalogItem[], editing: BamsConfig | null): { body: BamsConfigInput; metric: BamsMetricCatalogItem } | { error: string } {
  const metric = editing && isPattern(editing.metric_match) ? null : exactMetric(catalog, f.metric);
  if (!metric && !(editing && isPattern(editing.metric_match))) return { error: 'Choose an exact metric from the BAMS metric catalog.' };
  const threshold = Number(f.threshold);
  if (f.threshold.trim() === '' || !Number.isFinite(threshold)) return { error: 'Enter a valid threshold.' };
  const consecutive = Number(f.consecutive);
  if (!Number.isInteger(consecutive) || consecutive < 1) return { error: 'Consecutive updates must be 1 or greater.' };
  const cooldown = Number(f.cooldown);
  if (!Number.isInteger(cooldown) || cooldown < 0) return { error: 'Cooldown must be 0 or greater.' };
  const name = metric?.metric_name ?? editing!.metric_match;
  const body: BamsConfigInput = {
    name: editing?.name ?? policyName(name, f.operator, threshold, f.severity), metric_match: name, rule_type: 'fixed_threshold', operator: f.operator, threshold,
    reference_period: null, consecutive_updates: consecutive, severity: f.severity, cooldown_minutes: cooldown, enabled: f.enabled, auto_apply: true,
  };
  if (editing) { body.id = editing.id; body.expected_row_version = editing.row_version; }
  return { body, metric: metric ?? { metric_name: name, metric_count: editing!.matches, appliance_count: editing!.matches, account_count: 0 } };
}

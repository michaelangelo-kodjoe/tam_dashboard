// BAMS domain types (docs/04_API_CONTRACT.md §11 monitoring, §12 appliance import).
// Wire shapes are already domain-friendly (numbers are numbers, instants end in Z), so the
// ApiDataSource only normalises booleans; the mock adapter produces the same shapes.
import type { ISODate, ISOInstant } from './types';

export type BamsFreshness = 'Live' | 'Delayed' | 'Stale' | 'No Data';
export type AlertStatus = 'open' | 'recovered' | 'closed';
export type Severity = 'Info' | 'Warning' | 'Critical';
export type RuleType = 'fixed_threshold' | 'pct_of_high' | 'exceeds_high';
export type Operator = '>' | '>=' | '<' | '<=';
export type ReferencePeriod = '30d' | '60d' | '90d';
export type DisplayStatus = 'open' | 'recovered' | 'stale' | 'no_data' | 'delayed' | 'live' | 'disabled';
export type TrendRange = '24h' | '7d' | '30d' | '90d';
export const TREND_RANGES: TrendRange[] = ['24h', '7d', '30d', '90d'];

export interface BamsMonitor {
  state: 'running' | 'stopped' | 'provider_unavailable';
  desired_running: boolean;
  poll_interval_seconds: number;
  started_at: ISOInstant | null;
  last_poll_at: ISOInstant | null;
  next_poll_at: ISOInstant | null;
  last_poll_ok: boolean | null;
  last_error: string | null;
  freshness: { live_seconds: number; stale_seconds_default: number };
}
export interface BamsProvider {
  mode: 'DEV' | 'PROD';
  kind: 'simulated' | 'blpapi';
  available: boolean;
  simulated: boolean;
  message: string | null;
}

export interface BamsHigh { value: number | null; date: ISODate | null }
export interface BamsRowObject {
  id: string; name: string; client_id: string; client_name: string;
  region: string | null; location: string | null; environment: string | null; enabled: boolean; row_version: number;
}
export interface BamsRowAlert { id: string; status: AlertStatus; severity: Severity; opened_at: ISOInstant }
export interface BamsRow {
  id: string;
  metric_name: string;
  ticker: string;
  enabled: boolean;
  stale_after_seconds: number;
  row_version: number;
  object: BamsRowObject;
  current_value: number | null;
  last_source_update: ISOInstant | null;
  last_received: ISOInstant | null;
  age_seconds: number | null;
  freshness: BamsFreshness;
  simulated: boolean;
  highs: { d30: BamsHigh; d60: BamsHigh; d90: BamsHigh };
  alert: BamsRowAlert | null;
  active_alerts: number;
  display_status: DisplayStatus;
  spark?: number[];
}

export type BamsView = 'all' | 'active_alerts' | 'delayed_stale' | 'live' | 'no_data';
export const BAMS_VIEWS: BamsView[] = ['all', 'active_alerts', 'delayed_stale', 'live', 'no_data'];
export type BamsSortKey = 'status' | 'appliance' | 'location' | 'metric' | 'current' | 'high30' | 'high60' | 'high90' | 'last_update';
export type BamsStatusFilter = 'open' | 'recovered' | 'live' | 'delayed' | 'stale' | 'no_data';

export interface BamsStateQuery {
  view?: BamsView;
  /** one client id or a comma-separated list */
  account?: string;
  object_id?: string;
  location?: string;
  metric?: string;
  status?: BamsStatusFilter;
  q?: string;
  sort?: BamsSortKey;
  dir?: 'asc' | 'desc';
  include_disabled?: boolean;
  spark?: boolean;
}

export interface BamsSummary {
  active_alerts: number; open: number; recovered: number; delayed: number; stale: number; delayed_stale: number; live: number; no_data: number; total: number;
}
export interface BamsState {
  server_time: ISOInstant;
  monitor: BamsMonitor;
  provider: BamsProvider;
  banner: { code: string; text: string } | null;
  summary: BamsSummary;
  view_counts: Record<BamsView, number>;
  filters: {
    accounts: { id: string; name: string }[];
    locations: string[];
    objects: { id: string; name: string; client_id: string; client_name: string }[];
    metrics: string[];
  };
  counts: { rows: number; unfiltered: number; truncated?: boolean };
  rows: BamsRow[];
}

export interface BamsRule {
  id: string; metric_id: string; rule_type: RuleType; operator: Operator; threshold: number | null; reference_period: ReferencePeriod | null;
  consecutive_updates: number; severity: Severity; cooldown_minutes: number; enabled: boolean; suppress_until_clear: boolean;
  breach_count: number; preview: string; row_version: number; created_at: ISOInstant; updated_at: ISOInstant;
}
export interface BamsRuleInput {
  id?: string; metric_id?: string; rule_type: RuleType; operator?: Operator; threshold: number | null; reference_period: ReferencePeriod | null;
  consecutive_updates: number; severity: Severity; cooldown_minutes: number; enabled: boolean; suppress_until_clear: boolean; expected_row_version?: number;
}

export interface BamsAlertEvent {
  id: string; metric_id: string; rule_id: string | null; alert_type: RuleType; severity: Severity; status: AlertStatus; message: string;
  opened_at: ISOInstant; last_triggered_at: ISOInstant | null; recovered_at: ISOInstant | null; closed_at: ISOInstant | null;
  trigger_value: number | null; current_value: number | null; peak_value: number | null; closed_note: string | null;
  still_breaching: boolean; rule_summary: string | null; row_version: number;
}
export interface BamsAlertItem {
  event: BamsAlertEvent;
  metric: { id: string; metric_name: string; ticker: string };
  object: { id: string; name: string; client_id: string; client_name: string; location: string | null };
  freshness: BamsFreshness;
}
export type AlertListStatus = 'active' | 'open' | 'recovered' | 'closed' | 'all';
export interface BamsAlertList {
  counts: { active: number; open: number; recovered: number; closed: number };
  items: BamsAlertItem[];
  next_before: ISOInstant | null;
}

export interface BamsMetricDetail {
  row: BamsRow; rules: BamsRule[]; alerts: BamsAlertEvent[]; alerts_total: number; ranges: TrendRange[];
}
export interface BamsTrend {
  metric_id: string; range: TrendRange | 'custom'; from: ISOInstant; to: ISOInstant; /** monitor poll interval; present on window requests */ sample_interval_seconds?: number;
  points: { t: ISOInstant; v: number }[]; downsampled: boolean;
  text: { min: number | null; max: number | null; last: number | null; count: number; from: ISOInstant | null; to: ISOInstant | null };
  reference_lines: { id: string; label: string; value: number | null; date: ISODate | null }[];
  rule_lines: { rule_id: string; label: string; value: number; severity: Severity }[];
}

export interface BamsSettings {
  poll_interval_seconds: number; in_app_notifications: boolean; desktop_notifications: boolean; notify_recovered: boolean; privacy_mode: boolean;
}

export interface BamsMetricInput { id?: string; metric_name: string; ticker: string; enabled?: boolean; stale_after_seconds?: number; expected_row_version?: number }
export interface BamsObjectInput {
  id?: string; client_id?: string; name: string; region: string | null; location: string | null; environment: 'PROD' | 'DEV' | null; enabled: boolean;
  expected_row_version?: number; metrics: BamsMetricInput[];
}
export interface BamsObjectSaved {
  id: string; client_id: string; name: string; region: string | null; location: string | null; environment: string | null; enabled: boolean; row_version: number;
  metrics: { id: string; metric_name: string; ticker: string; enabled: boolean; stale_after_seconds: number; row_version: number }[];
}
export interface BamsDeletePreview {
  name: string; metrics: number; samples: number; rules: number; alerts_total: number; alerts_active: number; blocked: boolean; blocked_reason: string | null;
}
export interface BamsDeleteResult { id: string; name: string; metrics: number; samples: number; rules: number; alerts: number }

export interface BamsConfig {
  id: string; name: string; metric_match: string; rule_type: RuleType; operator: Operator; threshold: number | null; reference_period: ReferencePeriod | null;
  consecutive_updates: number; severity: Severity; cooldown_minutes: number; enabled: boolean; starter: boolean; /** persistent metric policy: matching metrics inherit a managed rule now and in the future */ auto_apply?: boolean; row_version: number; preview: string; matches: number;
}
/** Metric-first policy save (POST /bams/configs/save). Toggle sends only id, expected_row_version, enabled, auto_apply. */
export interface BamsConfigInput {
  id?: string; name?: string; metric_match?: string; rule_type?: RuleType; operator?: Operator; threshold?: number | null; reference_period?: ReferencePeriod | null;
  consecutive_updates?: number; severity?: Severity; cooldown_minutes?: number; enabled?: boolean; auto_apply?: boolean; expected_row_version?: number;
}
export interface BamsMetricCatalogItem { metric_name: string; metric_count: number; appliance_count: number; account_count: number }
export interface BamsConfigPreview {
  config_id: string; plan_hash: string; would_create: number; skipped_identical: number;
  metrics: { metric_id: string; metric_name: string; object_name: string; client_name: string; action: 'create' | 'skip_identical' }[];
}
export interface BamsConfigApplied { created: number; skipped_identical: number; rule_ids: string[] }

export interface BamsNotification {
  id: number; event_id: string; kind: 'opened' | 'recovered' | 'closed' | 'reminder'; attempted_at: ISOInstant; title: string; detail: string;
  severity: Severity; unread: boolean; status: AlertStatus;
}
export interface BamsNotifications { unread_count: number; items: BamsNotification[] }

// ---- Appliance import (contract §12) -----------------------------------------------------------
export type BamsRowState = 'new' | 'update' | 'unchanged' | 'needs_review' | 'invalid';
export interface BamsImportValues {
  account: string | null; bpid: string | null; appliance: string | null; metric: string | null; ticker: string | null;
  region: string | null; location: string | null; environment: string | null; enabled: boolean; stale_after_seconds: number;
}
export interface BamsImportRowIssue { field: string; code: string; text: string }
export interface BamsKept { existing: string | null; file: string | null; differs: boolean }
export interface BamsImportRow {
  row: number; state: BamsRowState; values: BamsImportValues; raw: Record<string, string> | null;
  target: { client_id: string; client_name: string; appliance: { id: string | null; name: string; is_new: boolean }; metric: { id: string | null; is_new: boolean } } | null;
  group: string | null; review_key: string | null;
  fills: Record<string, string>; kept: Record<string, BamsKept>;
  errors: BamsImportRowIssue[]; warnings: { code: string; text: string }[]; notes: string[];
}
export type BamsCandidateRef = { type: 'appliance'; id: string } | { type: 'group'; key: string };
export interface BamsCandidate {
  ref: BamsCandidateRef; name: string; region: string | null; location: string | null; environment: string | null; enabled?: boolean; row_version?: number;
  metric_count: number; metrics: string[]; strength: 'High' | 'Medium' | 'Low';
  reasons: { code: string; text: string }[]; differences: { code: string; text: string }[];
  fills: Record<string, string>; kept: Record<string, BamsKept>;
  metrics_added: string[]; metrics_existing: string[]; metrics_conflicts: { metric: string; ticker: string; owner: string }[]; notes: string[];
}
export interface BamsReviewGroup {
  key: string; client_id: string; client_name: string; rows: number[];
  file: { appliance: string; region: string | null; location: string | null; environment: string | null; metrics: string[] };
  strength: 'High' | 'Medium' | 'Low'; candidates: BamsCandidate[];
}
export interface BamsImportPlan {
  import_id: string; plan_hash: string; expires_at: ISOInstant;
  file: { name: string; size_bytes: number; format: 'xlsx' | 'csv'; sheet: string | null; rows_found: number; encoding: string | null; delimiter: string | null; notes: string[] };
  limits: { max_rows: number; max_candidates: number; max_bytes: number };
  counts: { rows: number; valid: number; new: number; updates: number; unchanged: number; needs_review: number; invalid: number };
  appliances: { new: number; updated: number; unchanged: number; needs_review: number };
  metrics: { new: number; updated: number; unchanged: number };
  warnings: { code: string; text: string }[];
  review: BamsReviewGroup[];
  rows: BamsImportRow[];
  /** Contract 13.7: appliances needing East/West or Environment for Operations. Informational only. */
  operations_note?: OperationsNote | null;
}
export interface OperationsNote { count: number; text: string | null }
export type BamsChoice = 'same' | 'different' | 'skip';
export interface BamsDecision { key: string; choice: BamsChoice; target?: BamsCandidateRef }
export interface BamsApplyInput { import_id: string; plan_hash: string; confirm: true; decisions: BamsDecision[] }
export interface BamsImportResult {
  import_id: string; applied_at: ISOInstant;
  file: { name: string; rows_found: number; format: 'xlsx' | 'csv' };
  counts: { appliances_created: number; appliances_updated: number; appliances_unchanged: number; metrics_created: number; metrics_updated: number; metrics_unchanged: number; skipped: number; invalid: number; overwritten: number };
  breakdown: Record<string, number>;
  decisions: { key: string; choice: BamsChoice; label: string }[];
  fields_filled: number; audit_events: number; audit_breakdown: Record<string, number>;
  backup: { name: string; reason: string; size_bytes: number } | null;
  touched_accounts: { id: string; name: string }[];
  created: { id: string; name: string; client_id: string; client_name: string; rows: number[]; metrics: string[] }[];
  updated: { id: string; name: string; client_id: string; client_name: string; rows: number[]; filled: string[]; metrics_added: string[] }[];
  skipped: { row: number; name: string; kind: string; reason: string }[];
  skipped_url: string | null;
  operations_note?: OperationsNote | null;
}

// Domain types shared by every DataSource. Booleans are real booleans here;
// adapters convert from the 0/1 columns used in SQLite / mock_data.json.

export type ISODate = string; // YYYY-MM-DD (no timezone, D-06)
export type ISOInstant = string; // ISO-8601 UTC, ends in Z

export const TASK_CATEGORIES = [
  'Client Follow-Up',
  'Engineering Follow-Up',
  'Reporting',
  'Internal',
  'Escalation',
  'Onboarding',
  'Entitlements',
  'Usage Review',
  'Meeting',
  'Other',
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_PRIORITIES = ['High', 'Medium', 'Low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ['Not Started', 'In Progress', 'Waiting', 'Complete'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const NOTE_TYPES = ['Meeting Note', 'Call Note', 'General Note'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export type ClientStatus = 'Active' | 'Inactive';

export interface Account {
  id: string;
  name: string;
  status: ClientStatus;
  bpid: string | null;
  products: string | null;
  last_contact: ISODate | null;
  next_contact: ISODate | null;
  notes: string | null;
  created_at: ISOInstant;
  updated_at: ISOInstant;
  row_version: number;
}

/** Account plus derived counts (queries/account_summary.sql). */
export interface AccountSummary extends Account {
  open_tasks: number;
  overdue: number;
  waiting: number;
  active_alerts: number;
  next_upgrade: ISODate | null;
  upcoming_upgrades: number;
  servers: number;
}

export interface Contact {
  id: string;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  team: string | null;
  is_primary: boolean;
  created_at: ISOInstant;
  updated_at: ISOInstant;
  row_version: number;
}

export interface Task {
  id: string;
  task: string;
  client_id: string | null;
  category: TaskCategory;
  priority: TaskPriority;
  due: ISODate | null;
  next_update: ISODate | null;
  status: TaskStatus;
  waiting: string | null;
  notes: string | null;
  archived: boolean;
  created_at: ISOInstant;
  updated_at: ISOInstant;
  row_version: number;
}

export interface Note {
  id: string;
  client_id: string;
  note_type: NoteType;
  timestamp: ISOInstant;
  subject: string | null;
  body: string | null;
  action_items: string | null;
  source: string;
  created_at: ISOInstant;
  updated_at: ISOInstant;
  row_version: number;
}

export type UpgradeStatus =
  | 'Planned'
  | 'Scheduled'
  | 'Awaiting Client'
  | 'In Progress'
  | 'Validation Required'
  | 'Completed'
  | 'Deferred'
  | 'Exception';
export type ValidationStatus = 'Pending' | 'Passed' | 'Failed' | 'Not Required';

export interface ServerUpgrade {
  id: string;
  client_id: string;
  server_name: string;
  environment: string;
  polarity: string;
  schedule_year: number | null;
  schedule_quarter: string | null;
  current_version: string | null;
  target_version: string | null;
  scheduled_date: ISODate | null;
  maintenance_window: string | null;
  status: UpgradeStatus;
  validation_status: ValidationStatus;
  waiting_on: string | null;
  reference: string | null;
  notes: string | null;
  updated_at: ISOInstant;
  row_version: number;
}

export type Freshness = 'Live' | 'Delayed' | 'Stale' | 'No Data' | 'Disabled';

export interface BamsObject {
  id: string;
  client_id: string;
  name: string;
  region: string | null;
  location: string | null;
  environment: string | null;
  enabled: boolean;
  /** Worst metric freshness (Stale > No Data > Delayed > Live); "Disabled" when not monitored. */
  worst_status: Freshness;
  metric_count: number;
  active_alerts: number;
}

export interface InfrastructureSummary {
  servers: number;
  active_alerts: number;
  next_upgrade: { date: ISODate; server: string } | null;
  env_summary: string; // e.g. "PROD 4 · DEV 1"
  regions: string[];
}

/** One metric series for a server tile (PM-AC-3). `points` are [ISO UTC instant, value], oldest first, at most 28. */
export interface ServerSpark {
  metric: string;
  window_hours: number;
  points: [ISOInstant, number][];
}

/** One tile per distinct server name (docs/01_PM_SPEC.md §10.4 #6, #7; PM-AC-3). */
export interface ServerTile {
  name: string;
  environment: string | null;
  version: string | null;
  /** worst open alert: Critical or Warning drive the tile; Info/null = healthy */
  alert_severity: 'Critical' | 'Warning' | 'Info' | null;
  spark: ServerSpark | null;
}

export interface Infrastructure {
  client_id: string;
  bams_objects: BamsObject[];
  upgrades: ServerUpgrade[];
  summary: InfrastructureSummary;
  servers: ServerTile[];
}

export interface Settings {
  default_landing: 'today' | 'accounts' | 'tasks';
  time_display: 'local' | 'gmt';
  auto_refresh_minutes: 'off' | '1' | '5' | '15';
  log_level: 'INFO' | 'DEBUG';
  open_browser_on_start: boolean;
}

export interface Runtime {
  ok: boolean;
  mode: 'DEV' | 'PROD';
  version: string;
  schema_version: number;
  db_path: string;
  /** Active database name (contract section 16); absent on older servers. */
  db_name?: string;
  backup_dir?: string;
  source: 'mock' | 'api';
}

export interface AppState {
  today: ISODate;
  accounts: AccountSummary[];
  tasks: Task[]; // non-archived
  contacts: Contact[];
  infrastructure: Record<string, InfrastructureSummary>;
  settings: Settings;
  runtime: Runtime;
}

// ---- Today ---------------------------------------------------------------

export type QueueKind = 'task' | 'client_follow_up' | 'bams_alert' | 'server_upgrade';
export type Urgency =
  | 'overdue'
  | 'critical'
  | 'due_today'
  | 'alert'
  | 'recovered'
  | 'waiting'
  | 'follow_up'
  | 'upgrade'
  | 'validation'
  | 'upcoming';
export type DateKind = 'due' | 'next_update' | 'next_contact' | 'opened' | 'scheduled';

export interface QueueItem {
  kind: QueueKind;
  id: string;
  /** null for Upcoming rows */
  tier: number | null;
  tier_label: string | null;
  client_id: string | null;
  client_name: string | null;
  type_label: string;
  title: string;
  status: string;
  priority: TaskPriority | null;
  severity: 'Info' | 'Warning' | 'Critical' | null;
  urgency: Urgency;
  date: string | null;
  date_kind: DateKind | null;
  days_delta: number | null;
  context: string | null;
  server_name: string | null;
}

export interface RecentChange {
  ts: ISOInstant;
  entry_key: string;
  client_id: string | null;
  client_name: string | null;
  object_type: string;
  object_id: string;
  sentence: string;
}

export interface AccountLoadRow {
  client_id: string;
  client_name: string;
  open_tasks: number;
  overdue: number;
  waiting: number;
  active_alerts: number;
  next_contact: ISODate | null;
}

/** "Done today N of M" (D-29, docs/01_PM_SPEC.md §10.2). Tasks only; done <= total always. */
export interface TodayProgress {
  day: ISODate;
  total: number;
  done: number;
  open: number;
  done_other: number;
}

export interface TodayData {
  today: ISODate;
  queue: QueueItem[];
  upcoming: QueueItem[];
  recent_changes: RecentChange[];
  account_load: AccountLoadRow[];
  /** null when the server predates PM-AC-1 */
  progress: TodayProgress | null;
  generated_at: ISOInstant;
}

/** GET /api/accounts/activity-trend (PM-AC-2): per account, `days` daily counts, oldest first. */
export interface ActivityTrend {
  today: ISODate;
  days: number;
  series: Record<string, number[]>;
}

// ---- Activity ------------------------------------------------------------

export type ActivityFilter = 'all' | 'meeting' | 'call' | 'general' | 'system';

export interface ActivityNoteEntry {
  entry_kind: 'note';
  entry_key: string;
  ts: ISOInstant;
  note: Note;
}
export interface ActivitySystemEntry {
  entry_kind: 'system';
  entry_key: string;
  ts: ISOInstant;
  object_type: string;
  object_id: string;
  sentence: string;
  source: string;
  severity: string | null;
  /** Server name to deep-link to infrastructure (BAMS / upgrades) */
  server_name: string | null;
}
export type ActivityEntry = ActivityNoteEntry | ActivitySystemEntry;

export interface ActivityPage {
  items: ActivityEntry[];
  /** opaque cursor for "Load more"; null when exhausted */
  next_cursor: string | null;
}

// ---- Inputs --------------------------------------------------------------

export interface AccountInput {
  id?: string;
  name: string;
  bpid: string | null;
  products: string | null;
  status: ClientStatus;
  next_contact: ISODate | null;
  notes: string | null;
  expected_row_version?: number;
  /** Create only: the user confirmed 'Different account' after a similar-name check (D-45). */
  duplicates_confirmed?: boolean;
}
export interface ContactInput {
  id?: string;
  client_id: string;
  name: string;
  role: string | null;
  email: string | null;
  team: string | null;
  is_primary: boolean;
  expected_row_version?: number;
}
export interface TaskInput {
  id?: string;
  task: string;
  client_id: string | null;
  category: TaskCategory;
  priority: TaskPriority;
  due: ISODate | null;
  next_update: ISODate | null;
  status: TaskStatus;
  waiting: string | null;
  notes: string | null;
  /** D-07, Client Follow-Up capture */
  update_next_contact?: boolean;
  expected_row_version?: number;
}
export interface NoteInput {
  id?: string;
  client_id: string;
  note_type: NoteType;
  timestamp: ISOInstant;
  subject: string | null;
  body: string | null;
  action_items: string | null;
  expected_row_version?: number;
}

export interface MutationResult<T> {
  item: T;
  side_effects: string[];
  /** Human text the UI can put in a toast, e.g. "B is now primary (was A)" */
  message?: string;
}

export interface BackupInfo {
  name: string;
  reason: string;
  size_bytes: number;
  created_at: ISOInstant;
}

export interface TaskQuery {
  client_id?: string;
  archived?: boolean;
  status?: TaskStatus;
}

// ---- Account bulk import and duplicate check (docs/04_API_CONTRACT.md §10, D-37..D-48) ----
// Strength is a word plus reasons (D-42); these types carry no numeric match field at all.

export type MatchStrength = 'High' | 'Medium' | 'Low';
export interface ReasonText { code: string; text: string }
export type CandidateRef = { type: 'account'; id: string } | { type: 'row'; row: number };
export type ImportField = 'name' | 'bpid' | 'products' | 'status' | 'next_contact' | 'notes';
export interface ImportValues {
  name: string | null; bpid: string | null; products: string | null; status: string | null; next_contact: string | null; notes: string | null;
}
export interface FillMap { [field: string]: string }
/** `differs` is false when the file holds the same value (nothing to say); only differing values are shown. */
export interface KeptMap { [field: string]: { existing: string; file: string | null; differs?: boolean } }

export interface SimilarCandidate {
  ref: CandidateRef;
  name: string;
  bpid: string | null;
  products: string | null;
  status: string | null;
  next_contact: string | null;
  row_version?: number;
  strength: MatchStrength;
  reasons: ReasonText[];
  differences: ReasonText[];
  /** import only: what "Same account" would write / keep */
  fills: FillMap;
  kept: KeptMap;
  notes: string[];
}
export interface ExactMatch { id: string; name: string; status: string; row_version: number }
export interface SimilarCheck { exact: ExactMatch | null; candidates: SimilarCandidate[] }

export type ImportRowState = 'new' | 'update' | 'needs_review' | 'invalid';
export interface ImportRowError { field: string | null; code: string; text: string }
export interface ImportRowMatch {
  kind: 'exact';
  account: ExactMatch;
  fills: FillMap;
  kept: KeptMap;
  notes: string[];
  reasons: ReasonText[];
}
export interface ImportRow {
  row: number;
  state: ImportRowState;
  values: ImportValues;
  raw: Record<string, string> | null;
  errors: ImportRowError[];
  warnings: ReasonText[];
  match: ImportRowMatch | null;
  merged_into: { row: number } | null;
  /** update rows: matched, nothing to fill */
  unchanged?: boolean;
  candidates: SimilarCandidate[];
}
export type ImportFormat = 'xlsx' | 'csv';
export interface ImportPlan {
  import_id: string;
  plan_hash: string;
  expires_at: string;
  file: {
    name: string; size_bytes: number; rows_found: number; format: ImportFormat;
    /** xlsx: the sheet read; csv: "CSV" */ sheet: string | null;
    /** csv only: 'UTF-8', 'UTF-8 (with BOM)', 'UTF-16' or 'Windows-1252' */ encoding: string | null;
    /** csv only: 'comma', 'semicolon', 'tab' or 'pipe' */ delimiter: string | null;
    /** display sentences about how the file was read (csv encoding and delimiter, extension mismatch) */ notes: string[];
  };
  limits: { max_rows: number; max_candidates: number };
  counts: { rows: number; valid: number; new: number; updates: number; needs_review: number; invalid: number; unchanged?: number };
  warnings: ReasonText[];
  rows: ImportRow[];
}
export type ImportChoice = 'same' | 'different' | 'skip';
export interface ImportDecision { row: number; choice: ImportChoice; target?: CandidateRef }
export interface ImportApplyInput { import_id: string; plan_hash: string; confirm: true; decisions: ImportDecision[] }
export interface ImportSkipped { row: number; name: string | null; kind: 'invalid' | 'by_user'; reason: string }
export interface ImportResult {
  import_id: string;
  applied_at: string;
  file: { name: string; rows_found: number; format?: ImportFormat };
  counts: { created: number; updated: number; unchanged: number; skipped: number; invalid: number; overwritten: number };
  breakdown: Record<string, number>;
  fields_filled: number;
  audit_events: number;
  backup: { name: string; reason: string; size_bytes: number } | null;
  created: { id: string; name: string; rows: number[] }[];
  updated: { id: string; name: string; rows: number[]; filled: string[] }[];
  skipped: ImportSkipped[];
}
export interface DownloadedFile { blob: Blob; filename: string }

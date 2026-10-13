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

export interface Infrastructure {
  client_id: string;
  bams_objects: BamsObject[];
  upgrades: ServerUpgrade[];
  summary: InfrastructureSummary;
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

export interface TodayData {
  today: ISODate;
  queue: QueueItem[];
  upcoming: QueueItem[];
  recent_changes: RecentChange[];
  account_load: AccountLoadRow[];
  generated_at: ISOInstant;
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

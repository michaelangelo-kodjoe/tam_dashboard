import type {
  AccountInput,
  Account,
  ActivityFilter,
  ActivityPage,
  ActivityTrend,
  AppState,
  BackupInfo,
  Contact,
  ContactInput,
  Infrastructure,
  MutationResult,
  Note,
  NoteInput,
  Runtime,
  Settings,
  Task,
  TaskInput,
  TaskQuery,
  TodayData,
} from '../types';

export type ErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'confirmation_required'
  | 'stale_write'
  | 'conflict'
  | 'not_implemented'
  | 'backup_failed'
  | 'network'
  | 'internal';

/** Uniform error for every adapter. `fields` maps input names to messages. */
export class DataSourceError extends Error {
  code: ErrorCode;
  fields?: Record<string, string>;
  status?: number;
  constructor(code: ErrorCode, message: string, fields?: Record<string, string>, status?: number) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
    this.fields = fields;
    this.status = status;
  }
}

export interface ActivityQuery {
  filter: ActivityFilter;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

/**
 * The single data boundary of the app. Components never fetch; they call
 * these methods through the DataProvider. Mock and HTTP adapters are
 * interchangeable (docs/01_PM_SPEC.md §6, T-23/T-40).
 */
export interface DataSource {
  readonly kind: 'mock' | 'api';

  getRuntime(): Promise<Runtime>;
  getState(): Promise<AppState>;
  getToday(): Promise<TodayData>;
  getActivity(clientId: string, query: ActivityQuery): Promise<ActivityPage>;
  getTasks(query: TaskQuery): Promise<Task[]>;
  getInfrastructure(clientId: string): Promise<Infrastructure>;
  /** Accounts activity-trend column (PM-AC-2). Active accounts only; 14 daily points by default. */
  getActivityTrend(days?: number): Promise<ActivityTrend>;

  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<MutationResult<Settings>>;
  getLogs(limit: number): Promise<string[]>;
  createBackup(): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;

  saveAccount(input: AccountInput): Promise<MutationResult<Account>>;
  deleteAccount(input: { id: string; confirm: true; confirm_name: string }): Promise<void>;

  saveContact(input: ContactInput): Promise<MutationResult<Contact>>;
  deleteContact(input: { id: string; confirm: true }): Promise<void>;

  saveTask(input: TaskInput): Promise<MutationResult<Task>>;
  archiveTask(input: { id: string; archived: boolean; expected_row_version?: number }): Promise<MutationResult<Task>>;
  deleteTask(input: { id: string; confirm: true }): Promise<void>;

  /** One note by id, or null if it does not exist (GET /api/note/{id}, FE-AC-1). */
  getNote(id: string): Promise<Note | null>;
  saveNote(input: NoteInput): Promise<MutationResult<Note>>;
  deleteNote(input: { id: string; confirm: true }): Promise<void>;
}

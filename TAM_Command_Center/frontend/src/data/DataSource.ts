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
  DownloadedFile,
  ImportApplyInput,
  ImportFormat,
  ImportPlan,
  ImportResult,
  Infrastructure,
  MutationResult,
  Note,
  NoteInput,
  Runtime,
  Settings,
  SimilarCheck,
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
  | 'invalid_file'
  | 'payload_too_large'
  | 'import_expired'
  | 'unresolved_duplicates'
  | 'preview_stale'
  | 'already_applied'
  | 'possible_duplicate'
  | 'network'
  | 'internal';

/** Uniform error for every adapter. `fields` maps input names to messages. */
export class DataSourceError extends Error {
  code: ErrorCode;
  fields?: Record<string, string>;
  status?: number;
  /** Free-form server `details` (invalid_file reason, unresolved rows, candidates, ...). */
  details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, fields?: Record<string, string>, status?: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
    this.fields = fields;
    this.status = status;
    this.details = details;
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

  // ---- Account bulk import (docs/04_API_CONTRACT.md §10) ------------------------------------
  /** Upload and inspect an .xlsx or .csv. Writes nothing. The adapter sniffs the content; the extension is never trusted. */
  inspectAccountsImport(file: File): Promise<ImportPlan>;
  /** Re-run validation and matching on the stored rows (after preview_stale). */
  getAccountsImport(importId: string): Promise<ImportPlan>;
  applyAccountsImport(input: ImportApplyInput): Promise<ImportResult>;
  downloadImportTemplate(format: ImportFormat): Promise<DownloadedFile>;
  /** Skipped rows, in the format of the uploaded file (`ImportResult.file.format`). */
  downloadSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile>;
  /** Same engine as the import (D-45). No write. */
  checkSimilarAccount(input: { name: string; bpid: string | null }): Promise<SimilarCheck>;
}

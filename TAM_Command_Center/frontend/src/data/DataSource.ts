import type { AuditFacets, AuditPage, AuditQuery } from '../types';
import type { DbRestorePreview, DbRestoreResult, RestoreIssueQuery, RestorePlan, RestoreResult } from '../portTypes';
import type { OpsApplianceInput, OpsData, OpsQuarter, OpsQuarterInput, OpsQuarterName, OpsQuery, OpsRow, OpsSetVersionResult } from '../opsTypes';
import type {
  AccountInput,
  Account,
  ActivityFilter,
  ActivityPage,
 
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
import type {
  AlertListStatus, BamsAlertEvent, BamsAlertList, BamsApplyInput, BamsConfig, BamsConfigApplied, BamsConfigInput, BamsMetricCatalogItem, BamsConfigPreview, BamsDeletePreview, BamsDeleteResult,
  BamsImportPlan, BamsImportResult, BamsMetricDetail, BamsMetricInput, BamsMonitor, BamsNotifications, BamsObjectInput, BamsObjectSaved, BamsProvider, BamsRule,
  BamsRuleInput, BamsSettings, BamsState, BamsStateQuery, BamsTrend, TrendRange,
} from '../bamsTypes';

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
  | 'import_failed'
  | 'restoring'
  | 'restore_expired'
  | 'confirm_mismatch'
  | 'restore_failed'
  | 'monitor_unavailable'
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

  // ---- BAMS monitoring (docs/04_API_CONTRACT.md §11) ----------------------------------------
  /** Cached state; never triggers a provider call. */
  getBamsState(query: BamsStateQuery): Promise<BamsState>;
  getBamsMetric(id: string): Promise<BamsMetricDetail>;
  getBamsTrend(id: string, range: TrendRange): Promise<BamsTrend>;
  /** Raw samples for a zoom window (contract 17.5): at most 7 days, from within 100 days. */
  getBamsTrendWindow(id: string, from: string, to: string): Promise<BamsTrend>;
  getBamsAlerts(query: { status?: AlertListStatus; account?: string; metric_id?: string; limit?: number }): Promise<BamsAlertList>;
  /** `expected_row_version` is deliberately not sent (contract §11.12 0c). */
  closeBamsAlert(input: { id: string; note: string | null }): Promise<{ event: BamsAlertEvent; suppressed_until_clear: boolean }>;
  setBamsMonitor(run: boolean): Promise<{ monitor: BamsMonitor }>;
  getBamsMonitor(): Promise<{ monitor: BamsMonitor; provider: BamsProvider }>;
  getBamsSettings(): Promise<BamsSettings>;
  saveBamsSettings(patch: Partial<BamsSettings>): Promise<BamsSettings>;
  saveBamsObject(input: BamsObjectInput): Promise<MutationResult<BamsObjectSaved>>;
  saveBamsMetric(input: BamsMetricInput & { object_id?: string }): Promise<void>;
  getBamsDeletePreview(kind: 'object' | 'metric', id: string): Promise<BamsDeletePreview>;
  deleteBamsItem(kind: 'object' | 'metric', input: { id: string; expected_row_version?: number }): Promise<BamsDeleteResult>;
  saveBamsRule(input: BamsRuleInput): Promise<BamsRule>;
  deleteBamsRule(input: { id: string; expected_row_version?: number }): Promise<void>;
  getBamsConfigs(): Promise<BamsConfig[]>;
  getBamsMetricCatalog(): Promise<BamsMetricCatalogItem[]>;
  saveBamsConfig(input: BamsConfigInput): Promise<BamsConfig>;
  deleteBamsConfig(input: { id: string }): Promise<void>;
  previewBamsConfig(input: { config_id: string; metric_ids?: string[] | null }): Promise<BamsConfigPreview>;
  applyBamsConfig(input: { config_id: string; metric_ids?: string[] | null; plan_hash: string }): Promise<BamsConfigApplied>;
  getBamsNotifications(limit?: number): Promise<BamsNotifications>;
  markBamsNotificationsRead(input: { through_id: number } | { all: true }): Promise<number>;

  // ---- BAMS appliance import (contract §12); same session rules as the accounts import ------
  inspectBamsImport(file: File): Promise<BamsImportPlan>;
  getBamsImport(importId: string): Promise<BamsImportPlan>;
  applyBamsImport(input: BamsApplyInput): Promise<BamsImportResult>;
  downloadBamsImportTemplate(format: ImportFormat): Promise<DownloadedFile>;
  downloadBamsSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile>;

  // ---- Operations (contract section 13) -------------------------------------------------------
  getOperations(query: OpsQuery): Promise<OpsData>;
  saveOperationsQuarter(input: OpsQuarterInput): Promise<OpsQuarter>;
  /** The backend answers 409 confirmation_required unless `confirm` is true. */
  deleteOperationsQuarter(input: { year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): Promise<void>;
  saveOperationsAppliance(input: OpsApplianceInput): Promise<OpsRow>;
  resetOperationsAppliance(input: { object_id: string; year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): Promise<OpsRow>;
  setOperationsVersion(input: { year: number; quarter: OpsQuarterName; object_ids: string[]; target_version: string | null }): Promise<OpsSetVersionResult>;

  // ---- Portability (contract section 14) ------------------------------------------------------
  exportExcel(): Promise<DownloadedFile>;
  exportDatabase(): Promise<DownloadedFile>;
  /** One file per call; `session` adds a CSV to an existing session, `table` forces the table of a CSV. Writes nothing. */
  inspectRestoreFile(file: File, opts?: { session?: string; table?: string }): Promise<RestorePlan>;
  getRestorePlan(id: string, q?: RestoreIssueQuery): Promise<RestorePlan>;
  removeRestoreFile(id: string, fileId: string): Promise<RestorePlan>;
  setRestoreTable(id: string, fileId: string, table: string): Promise<RestorePlan>;
  applyRestore(input: { restore_id: string; plan_hash: string }): Promise<RestoreResult>;
  downloadRestoreSkipped(id: string, format: ImportFormat): Promise<DownloadedFile>;
  /** Whole-database restore (D-136..D-142). Answers 501 not_implemented until backend phase 2. */
  inspectDatabaseRestore(file: File): Promise<DbRestorePreview>;
  previewBackupRestore(name: string): Promise<DbRestorePreview>;
  cancelDatabaseRestore(id: string): Promise<void>;
  applyDatabaseRestore(input: { restore_id: string; confirm: string }): Promise<DbRestoreResult>;

  // ---- Audit log (contract 18.2), read-only --------------------------------------------------
  getAudit(q: AuditQuery): Promise<AuditPage>;
  getAuditFacets(): Promise<AuditFacets>;
  /** CSV of the matching rows, no paging; 413 payload_too_large when more than 50,000 rows match. */
  exportAudit(q: AuditQuery): Promise<DownloadedFile>;

  /** Application log files (contract 18.4): zip of all (default) or the current file. `omitted` counts older files left out by the size cap. */
  downloadLogs(file: 'zip' | 'current'): Promise<DownloadedFile>;
}

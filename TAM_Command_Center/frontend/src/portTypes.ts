// Portability types (docs/04_API_CONTRACT.md section 14).
export const PORT_TABLES = ['accounts', 'contacts', 'tasks', 'notes', 'appliances', 'metrics', 'quarters', 'records'] as const;
export type PortTable = (typeof PORT_TABLES)[number];
export type RestoreFileState = 'ready' | 'unrecognized' | 'missing_columns';

export interface RestoreFile {
  file_id: string; name: string; format: 'xlsx' | 'csv'; size_bytes: number; table: PortTable | null; table_label: string | null;
  table_source: 'sheets' | 'headers' | 'filename' | 'chosen' | 'none'; state: RestoreFileState; missing_columns: string[]; rows: number;
  encoding?: string | null; delimiter?: string | null; ignored_columns?: string[];
  /** xlsx only: the workbook is one entry; its sheets (tables) are listed here. */
  sheets?: { table: PortTable; label: string; rows: number }[];
}
export interface RestoreTable { key: PortTable; label: string; staged: boolean; new: number; identical: number; differs: number; invalid: number; rows: number }
export interface RestoreTotals { new: number; identical: number; differs: number; invalid: number; rows: number }
export interface RestoreIssue { table: PortTable; table_label: string; row: number; outcome: 'differs' | 'invalid'; column: string | null; code: string; text: string; problems: number; file_id: string }
export interface RestorePlan {
  restore_id: string; plan_hash: string; expires_at: string; kind: 'xlsx' | 'csv';
  source: { app: string; version: string; schema_version: number; channel: string; exported_at: string } | null;
  csv_notice: string | null;
  limits: { max_file_bytes: number; max_sheet_rows: number; max_total_rows: number; max_csv_files: number };
  files: RestoreFile[]; tables: RestoreTable[]; totals: RestoreTotals;
  blocking: { code: string; file_id?: string; text: string }[]; warnings: { code: string; text: string }[];
  can_apply: boolean; nothing_to_restore: boolean; apply_label: string;
  issues: RestoreIssue[]; issues_total: number;
}
export interface RestoreResult {
  restore_id: string; applied_at: string; kind: 'xlsx' | 'csv'; files: string[];
  counts: { added: number; identical: number; differs: number; invalid: number; skipped: number };
  tables: { key: PortTable; label: string; added: number; identical: number; differs: number; invalid: number }[];
  backup: { name: string; reason: string; size_bytes: number } | null; audit_events: number; skipped_total: number; skipped_preview: RestoreIssue[];
}
export interface RestoreIssueQuery { table?: PortTable; outcome?: 'differs' | 'invalid'; limit?: number; offset?: number }

export const DB_COUNT_KEYS = ['accounts', 'contacts', 'tasks', 'notes', 'appliances', 'metrics', 'quarters', 'upgrade_records', 'audit_events', 'bams_history'] as const;
export type DbCountKey = (typeof DB_COUNT_KEYS)[number];
export interface DbSide {
  schema_version: number; will_upgrade_from?: number | null; latest_activity: string | null; channel: string | null; counts: Record<DbCountKey, number>;
}
export interface DbRestorePreview {
  restore_id: string; expires_at: string; source: { kind: 'upload' | 'backup'; name: string };
  file: DbSide; current: DbSide; fewer: DbCountKey[]; warning: string; confirm_word: string;
}
export interface DbRestoreResult { restored: true; backup: { name: string; reason?: string; size_bytes?: number }; counts: Record<string, number>; schema_version: number }

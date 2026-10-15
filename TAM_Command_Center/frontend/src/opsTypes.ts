// Operations wire/domain types (docs/04_API_CONTRACT.md section 13).
export type OpsQuarterName = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export const OPS_STATUSES = ['Planned', 'Awaiting Client', 'Scheduled', 'In Progress', 'Completed', 'Deferred'] as const;
export type OpsStatus = (typeof OPS_STATUSES)[number] | 'Validation Required' | 'Exception';

export interface OpsQuarter {
  year: number; quarter: OpsQuarterName; label: string; target_version: string | null;
  dev_date: string | null; east_prod_date: string | null; west_prod_date: string | null; row_version: number; records: number;
}
export interface OpsSummary { total: number; by_status: Record<string, number>; overdue: number }
export interface OpsRow {
  object_id: string; client_id: string; client_name: string; appliance: string; enabled: boolean;
  environment: 'PROD' | 'DEV' | null; polarity: 'East' | 'West' | null; region: string | null; object_row_version: number;
  record_id: string | null; record_row_version: number | null; status: OpsStatus; status_is_default: boolean; overdue: boolean;
  date: { effective: string | null; source: 'quarter' | 'override' | 'none'; override: string | null; derived: string | null; reason: string | null };
  version: { effective: string | null; source: 'quarter' | 'appliance' | 'none'; own: string | null; quarter_default: string | null };
  notes: string | null; can_record: boolean; record_problem: string | null;
}
export interface OpsGroup { client_id: string; client_name: string; count: number; summary: OpsSummary; rows: OpsRow[] }
export interface OpsData {
  today: string; empty: 'no_quarters' | 'no_appliances' | null; quarters: OpsQuarter[]; selected: OpsQuarter | null; default_selected: boolean;
  appliance_total: number; summary: OpsSummary; groups: OpsGroup[];
}
export interface OpsQuery {
  year?: number; quarter?: OpsQuarterName; q?: string; status?: string; environment?: 'PROD' | 'DEV' | 'unset'; polarity?: 'East' | 'West' | 'unset'; client_id?: string;
}
export interface OpsQuarterInput {
  year: number; quarter: OpsQuarterName; apics_version: string | null; dev_upgrade_date: string | null; east_prod_date: string | null; west_prod_date: string | null; expected_row_version?: number;
}
export interface OpsApplianceInput {
  object_id: string; year: number; quarter: OpsQuarterName; status?: OpsStatus; date_override?: string | null; target_version?: string | null; notes?: string | null; expected_row_version?: number;
}
export interface OpsVersionTag { object_id: string; appliance: string; client_name: string }
export interface OpsSetVersionResult {
  target_version: string | null; message: string; updated: OpsVersionTag[]; unchanged: OpsVersionTag[];
  skipped: (OpsVersionTag & { code: 'needs_polarity' | 'needs_environment' | 'not_found'; reason: string })[];
}

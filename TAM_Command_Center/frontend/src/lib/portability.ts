import type { DbCountKey, PortTable } from '../portTypes';

export const COUNT_LABELS: Record<DbCountKey, string> = {
  accounts: 'Accounts', contacts: 'Contacts', tasks: 'Tasks', notes: 'Notes', appliances: 'Appliances', metrics: 'Metrics',
  quarters: 'Operations quarters', upgrade_records: 'Upgrade records', audit_events: 'Audit events', bams_history: 'BAMS history',
};
export const TABLE_OPTIONS: { value: PortTable; label: string }[] = [
  { value: 'accounts', label: 'Accounts' }, { value: 'contacts', label: 'Contacts' }, { value: 'tasks', label: 'Tasks' }, { value: 'notes', label: 'Notes' },
  { value: 'appliances', label: 'Appliances' }, { value: 'metrics', label: 'Metrics' }, { value: 'quarters', label: 'Operations Quarters' }, { value: 'records', label: 'Operations Records' },
];

/** Full page reload (all cached queries, selections and drafts are discarded). Isolated so tests can replace it. */
export const reloader = { reload: () => window.location.reload() };

export function fmtBytes(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

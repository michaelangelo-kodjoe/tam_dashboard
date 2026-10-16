// Mock portability engine (contract section 14). CSV restore only (the workbook path needs the live server);
// rows are classified against the in-memory tables, and apply reports counts without changing the mock tables.
import type { DbCountKey, DbRestorePreview, DbRestoreResult, DbSide, PortTable, RestoreFile, RestoreIssue, RestoreIssueQuery, RestorePlan, RestoreResult, RestoreTable } from '../../portTypes';
import { DB_COUNT_KEYS, PORT_TABLES } from '../../portTypes';
import { DataSourceError } from '../DataSource';
import { FileRefusal, parseCsv, readBytes, sniff } from '../importFile';
import type { Row } from './rebase';

const LABEL: Record<PortTable, string> = { accounts: 'Accounts', contacts: 'Contacts', tasks: 'Tasks', notes: 'Notes', appliances: 'Appliances', metrics: 'Metrics', quarters: 'Operations Quarters', records: 'Operations Records' };
const DB: Record<PortTable, string> = { accounts: 'clients', contacts: 'contacts', tasks: 'tasks', notes: 'notes', appliances: 'bams_objects', metrics: 'bams_metrics', quarters: 'quarterly_upgrade_windows', records: 'server_upgrades' };
const REQ: Record<PortTable, string[]> = {
  accounts: ['id', 'name'], contacts: ['id', 'client_id', 'name'], tasks: ['id', 'task'], notes: ['id', 'client_id', 'note_type', 'timestamp'],
  appliances: ['id', 'client_id', 'name'], metrics: ['id', 'object_id', 'metric_name', 'ticker'], quarters: ['schedule_year', 'schedule_quarter'],
  records: ['id', 'client_id', 'server_name', 'environment', 'polarity'],
};
const COUNT_TABLE: Record<DbCountKey, string> = { accounts: 'clients', contacts: 'contacts', tasks: 'tasks', notes: 'notes', appliances: 'bams_objects', metrics: 'bams_metrics', quarters: 'quarterly_upgrade_windows', upgrade_records: 'server_upgrades', audit_events: 'audit_events', bams_history: 'bams_metric_samples' };

interface Staged { file: RestoreFile; headers: string[]; rows: Record<string, string>[] }
interface Session { id: string; files: Staged[]; applied: RestoreResult | null; seq: number }
interface Ctx { t: Record<string, Row[]>; now: () => string; uuid: () => string; backups: () => { name: string; reason: string; size_bytes: number }[]; backup: () => { name: string; reason: string; size_bytes: number }; schema: number }

export class MockPortability {
  private sessions = new Map<string, Session>();
  private dbSessions = new Map<string, DbRestorePreview>();
  constructor(private c: Ctx) {}

  private detect(headers: string[]): { table: PortTable | null; src: RestoreFile['table_source'] } {
    const h = new Set(headers.map((x) => x.trim().toLowerCase()));
    const cands = PORT_TABLES.filter((t) => REQ[t].every((r) => h.has(r)));
    return cands.length === 1 ? { table: cands[0], src: 'headers' } : { table: null, src: 'none' };
  }
  private state(f: Staged): void {
    const t = f.file.table;
    if (!t) { f.file.state = 'unrecognized'; f.file.missing_columns = []; return; }
    const h = new Set(f.headers.map((x) => x.trim().toLowerCase()));
    f.file.missing_columns = REQ[t].filter((r) => !h.has(r));
    f.file.state = f.file.missing_columns.length ? 'missing_columns' : 'ready';
  }

  async inspect(file: File, opts: { session?: string; table?: string }): Promise<RestorePlan> {
    let kind: 'xlsx' | 'csv';
    try { kind = sniff(file.name, (await readBytes(file.slice(0, 8192))).subarray(0, 8192)).format; } catch (e) {
      if (e instanceof FileRefusal) throw new DataSourceError('invalid_file', e.message, undefined, 422, { reason: e.reason });
      throw e;
    }
    if (kind === 'xlsx') throw new DataSourceError('invalid_file', 'This is not an export from this app (the mock server restores CSV files only).', undefined, 422, { reason: 'not_an_export' });
    const s = opts.session ? this.session(opts.session) : { id: this.c.uuid(), files: [] as Staged[], applied: null, seq: 0 };
    if (!opts.session) this.sessions.set(s.id, s);
    if (s.files.length >= 9) throw new DataSourceError('invalid_file', 'You can add at most nine CSV files.', undefined, 422, { reason: 'too_many_files' });
    const read = parseCsv(await readBytes(file));
    const headers = (read.grid[0] ?? []).map((c) => c.v.trim());
    const rows = read.grid.slice(1).filter((r) => r.some((c) => c.v.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), r[i]?.v ?? ''])));
    const forced = opts.table && (PORT_TABLES as readonly string[]).includes(opts.table) ? (opts.table as PortTable) : null;
    const d = forced ? { table: forced, src: 'chosen' as const } : this.detect(headers);
    if (d.table && s.files.some((f) => f.file.table === d.table)) throw new DataSourceError('invalid_file', `${LABEL[d.table]} is already added; remove it first.`, undefined, 422, { reason: 'table_already_added' });
    const f: Staged = { headers, rows, file: { file_id: this.c.uuid(), name: file.name, format: 'csv', size_bytes: file.size, table: d.table, table_label: d.table ? LABEL[d.table] : null, table_source: d.src, state: 'ready', missing_columns: [], rows: rows.length, encoding: read.encoding, delimiter: read.delimiter, ignored_columns: [] } };
    this.state(f);
    s.files.push(f);
    return this.plan(s);
  }
  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new DataSourceError('import_expired', 'This restore timed out. Choose the file again.', undefined, 410);
    return s;
  }
  private classify(s: Session): { tables: RestoreTable[]; issues: RestoreIssue[] } {
    const issues: RestoreIssue[] = [];
    const tables = PORT_TABLES.map((key): RestoreTable => {
      const f = s.files.find((x) => x.file.table === key && x.file.state === 'ready');
      const t: RestoreTable = { key, label: LABEL[key], staged: !!f, new: 0, identical: 0, differs: 0, invalid: 0, rows: f?.rows.length ?? 0 };
      if (!f) return t;
      const idCol = key === 'quarters' ? null : 'id';
      const existing = this.c.t[DB[key]] ?? [];
      f.rows.forEach((r, i) => {
        const row = i + 2;
        const miss = REQ[key].find((q) => !(r[q] ?? '').trim());
        if (miss) { t.invalid++; issues.push({ table: key, table_label: LABEL[key], row, outcome: 'invalid', column: miss, code: 'required', text: `${LABEL[key]} row ${row}: ${miss}: required`, problems: 1, file_id: f.file.file_id }); return; }
        const hit = idCol ? existing.find((e) => String(e.id) === r.id) : existing.find((e) => String(e.schedule_year) === r.schedule_year && e.schedule_quarter === r.schedule_quarter);
        if (!hit) { t.new++; return; }
        const differing = Object.keys(r).find((k) => k !== 'row_version' && k in hit && String(hit[k] ?? '') !== r[k]);
        if (differing) { t.differs++; issues.push({ table: key, table_label: LABEL[key], row, outcome: 'differs', column: differing, code: 'differs', text: `${LABEL[key]} row ${row}: differs from the database in ${differing}`, problems: 1, file_id: f.file.file_id }); } else t.identical++;
      });
      return t;
    });
    return { tables, issues };
  }
  plan(s: Session | string, q: RestoreIssueQuery = {}): RestorePlan {
    const sess = typeof s === 'string' ? this.session(s) : s;
    if (sess.applied) throw new DataSourceError('already_applied', 'This restore was already applied.', undefined, 409, { result: sess.applied });
    const { tables, issues } = this.classify(sess);
    const totals = tables.reduce((a, t) => ({ new: a.new + t.new, identical: a.identical + t.identical, differs: a.differs + t.differs, invalid: a.invalid + t.invalid, rows: a.rows + t.rows }), { new: 0, identical: 0, differs: 0, invalid: 0, rows: 0 });
    const blocking = sess.files.filter((f) => f.file.state !== 'ready').map((f) => ({ code: f.file.state === 'unrecognized' ? 'unrecognized_file' : 'missing_columns', file_id: f.file.file_id, text: f.file.state === 'unrecognized' ? `${f.file.name}: choose which table this file holds.` : `${f.file.name}: missing columns ${f.file.missing_columns.join(', ')}.` }));
    const filtered = issues.filter((i) => (!q.table || i.table === q.table) && (!q.outcome || i.outcome === q.outcome));
    const staged = sess.files.length > 0;
    return {
      restore_id: sess.id, plan_hash: `sha256:${sess.files.map((f) => f.file.file_id).join('')}${totals.new}`, expires_at: new Date(Date.now() + 600_000).toISOString(), kind: 'csv', source: null,
      csv_notice: 'CSV files cannot tell which database they came from; check the source.',
      limits: { max_file_bytes: 25 * 1_048_576, max_sheet_rows: 10_000, max_total_rows: 50_000, max_csv_files: 9 },
      files: sess.files.map((f) => f.file), tables, totals, blocking, warnings: [],
      can_apply: staged && blocking.length === 0 && totals.new > 0, nothing_to_restore: staged && blocking.length === 0 && totals.new === 0,
      apply_label: `Add ${totals.new} missing ${totals.new === 1 ? 'row' : 'rows'}`,
      issues: filtered.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 200)), issues_total: filtered.length,
    };
  }
  get(id: string, q: RestoreIssueQuery): RestorePlan { return this.plan(id, q); }
  remove(id: string, fileId: string): RestorePlan {
    const s = this.session(id);
    if (!s.files.some((f) => f.file.file_id === fileId)) throw new DataSourceError('not_found', 'That file is not in this restore.', undefined, 404);
    s.files = s.files.filter((f) => f.file.file_id !== fileId);
    return this.plan(s);
  }
  setTable(id: string, fileId: string, table: string): RestorePlan {
    const s = this.session(id);
    const f = s.files.find((x) => x.file.file_id === fileId);
    if (!f) throw new DataSourceError('not_found', 'That file is not in this restore.', undefined, 404);
    const t = table as PortTable;
    if (!PORT_TABLES.includes(t)) throw new DataSourceError('validation_error', 'Unknown table.', undefined, 422);
    if (s.files.some((x) => x !== f && x.file.table === t)) throw new DataSourceError('invalid_file', `${LABEL[t]} is already added; remove it first.`, undefined, 422, { reason: 'table_already_added' });
    f.file.table = t; f.file.table_label = LABEL[t]; f.file.table_source = 'chosen';
    this.state(f);
    return this.plan(s);
  }
  apply(input: { restore_id: string; plan_hash: string }): RestoreResult {
    const s = this.session(input.restore_id);
    const p = this.plan(s);
    if (input.plan_hash !== p.plan_hash) throw new DataSourceError('preview_stale', 'The data changed since the preview. Review it again.', undefined, 409);
    if (!p.can_apply) throw new DataSourceError('conflict', p.nothing_to_restore ? 'There is nothing to restore.' : 'Some files are not ready.', undefined, 409);
    const b = this.c.backup();
    const result: RestoreResult = {
      restore_id: s.id, applied_at: this.c.now(), kind: 'csv', files: s.files.map((f) => f.file.name),
      counts: { added: p.totals.new, identical: p.totals.identical, differs: p.totals.differs, invalid: p.totals.invalid, skipped: p.totals.differs + p.totals.invalid },
      tables: p.tables.filter((t) => t.staged).map((t) => ({ key: t.key, label: t.label, added: t.new, identical: t.identical, differs: t.differs, invalid: t.invalid })),
      backup: { name: b.name, reason: 'pre-import', size_bytes: b.size_bytes }, audit_events: p.tables.filter((t) => t.staged).length,
      skipped_total: p.totals.differs + p.totals.invalid, skipped_preview: p.issues.slice(0, 20),
    };
    s.applied = result;
    return result;
  }
  skipped(id: string): void {
    const s = this.session(id);
    if (!s.applied) throw new DataSourceError('conflict', 'This restore has not been applied yet.', undefined, 409);
  }

  // ---- database restore ----------------------------------------------------------------------
  private side(): DbSide {
    const counts = Object.fromEntries(DB_COUNT_KEYS.map((k) => [k, (this.c.t[COUNT_TABLE[k]] ?? []).length])) as Record<DbCountKey, number>;
    return { schema_version: this.c.schema, latest_activity: this.c.now(), channel: 'DEV', counts };
  }
  private preview(kind: 'upload' | 'backup', name: string): DbRestorePreview {
    const current = this.side();
    const file = this.side();
    file.counts = { ...file.counts, notes: Math.max(0, file.counts.notes - 2), audit_events: Math.max(0, file.counts.audit_events - 5) };
    const p: DbRestorePreview = {
      restore_id: this.c.uuid(), expires_at: new Date(Date.now() + 600_000).toISOString(), source: { kind, name }, file, current,
      fewer: DB_COUNT_KEYS.filter((k) => file.counts[k] < current.counts[k]),
      warning: 'Everything currently in the app will be replaced. A safety backup is taken first and stays in the Backups list.', confirm_word: 'RESTORE',
    };
    this.dbSessions.set(p.restore_id, p);
    return p;
  }
  async inspectDb(file: File): Promise<DbRestorePreview> {
    const head = await readBytes(file.slice(0, 16));
    if (new TextDecoder().decode(head).slice(0, 15) !== 'SQLite format 3') throw new DataSourceError('invalid_file', 'This is not a SQLite database file.', undefined, 422, { reason: 'not_sqlite' });
    return this.preview('upload', file.name);
  }
  fromBackup(name: string): DbRestorePreview {
    if (!this.c.backups().some((b) => b.name === name)) throw new DataSourceError('not_found', 'That backup is not in the list.', undefined, 404);
    return this.preview('backup', name);
  }
  cancelDb(id: string): void { this.dbSessions.delete(id); }
  applyDb(input: { restore_id: string; confirm: string }): DbRestoreResult {
    const p = this.dbSessions.get(input.restore_id);
    if (!p) throw new DataSourceError('restore_expired', 'This restore timed out. Start again.', undefined, 410);
    if (input.confirm !== 'RESTORE') throw new DataSourceError('confirm_mismatch', 'Type RESTORE exactly to continue.', undefined, 409);
    const b = this.c.backup();
    this.dbSessions.delete(input.restore_id);
    return { restored: true, backup: { name: b.name, reason: 'pre-restore', size_bytes: b.size_bytes }, counts: p.file.counts, schema_version: p.file.schema_version };
  }
}

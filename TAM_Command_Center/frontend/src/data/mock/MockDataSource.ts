// MockDataSource: loads db/mock_data.json, applies the documented rebase rule and
// the frozen BAMS mock clock, and implements CRUD, audit, Today ranking and activity
// in memory. Behaves like the future HTTP backend (validation, row_version, side effects).
import type {
  Account,
  AccountInput,
  AccountLoadRow,
  ActivityEntry,
  ActivityPage,
  ActivityTrend,
  AppState,
  BackupInfo,
  Contact,
  DownloadedFile,
  ImportApplyInput,
  ImportFormat,
  ImportPlan,
  ImportResult,
  SimilarCandidate,
  SimilarCheck,
  ContactInput,
  Infrastructure,
  MutationResult,
  Note,
  NoteInput,
  RecentChange,
  Runtime,
  Settings,
  Task,
  TaskInput,
  TaskQuery,
  TodayData,
} from '../../types';
import { DataSourceError, type ActivityQuery, type DataSource } from '../DataSource';
import { addDays, instantLocalDate, localToday } from '../../lib/dates';
import { clean, validateAccount, validateContact, validateNote, validateTask } from '../../lib/validate';
import {
  accountSummary,
  auditSentence,
  bamsSentence,
  infrastructure,
  infrastructureSummary,
  toAccount,
  toContact,
  toNote,
  toTask,
} from './derive';
import { compare, exactKey, orderHits } from './dupes';
import { buildPlan, checkDecisions, computeEffects, parseGrid, type AcctRec, type Parsed } from './mockImport';
import { FileRefusal, MAX_BYTES, parseCsv, parseXlsx, readBytes, sniff, toCsv, xlsxBlob, COLUMNS } from '../importFile';
import { rebaseTables, type MockFile, type Row, type Tables } from './rebase';
import { rankToday } from './today';
import { MockBams } from './mockBams';
import { MockOperations } from './mockOperations';
import { MockPortability } from './mockPortability';
import type { DbRestorePreview, DbRestoreResult, RestoreIssueQuery, RestorePlan, RestoreResult } from '../../portTypes';
import type { OpsApplianceInput, OpsData, OpsQuarter, OpsQuarterInput, OpsQuarterName, OpsQuery, OpsRow, OpsSetVersionResult } from '../../opsTypes';
import { MockBamsImport, bamsTemplateRows, parseBamsGrid } from './mockBamsImport';
import type {
  AlertListStatus, BamsAlertEvent, BamsAlertList, BamsApplyInput, BamsConfig, BamsConfigApplied, BamsConfigPreview, BamsDeletePreview, BamsDeleteResult, BamsImportPlan,
  BamsImportResult, BamsMetricDetail, BamsMetricInput, BamsMonitor, BamsNotifications, BamsObjectInput, BamsObjectSaved, BamsProvider, BamsRule, BamsRuleInput, BamsSettings,
  BamsState, BamsStateQuery, BamsTrend, TrendRange,
} from '../../bamsTypes';
import { browserLocalMidnight, bucketCounts, dayProgress, trendBounds, type LocalMidnight } from './progress';

export interface MockOptions {
  /** Local calendar date to rebase to. Defaults to the real local date. */
  today?: string;
  /** Instant used as the frozen BAMS clock. Default: real now (when today is real) else today 12:00Z. */
  loadNow?: Date;
  /** `unavailable` simulates the PROD stub provider: every BAMS value is No Data (mockup 02). */
  bamsProvider?: 'dev' | 'unavailable';
  /** Artificial latency per call, to see loading states. */
  delayMs?: number;
  /** Clock for audit timestamps written by mutations. Default: the real clock. Tests inject a fixed one. */
  now?: () => Date;
  /** Local midnight of a day as a UTC instant (progress ring and activity trend windows). Default: browser zone. */
  localMidnight?: LocalMidnight;
  /** Source of the JSON. Tests pass the file object directly. */
  file?: MockFile;
  url?: string;
}

const VERSION = '0.1.0-dev';
const SYSTEM_AUDIT_ACTIONS: Record<string, string[]> = {
  task: ['created', 'completed', 'reopened', 'archived', 'deleted'],
  contact: ['created', 'updated', 'deleted', 'primary_changed'],
  note: ['deleted'],
  client: ['next_contact_changed', 'status_changed'],
};
const RECENT_AUDIT_ACTIONS: Record<string, string[]> = {
  note: ['created', 'deleted'],
  task: ['created', 'completed', 'reopened', 'archived', 'deleted'],
  contact: ['created', 'updated', 'deleted', 'primary_changed'],
  client: ['next_contact_changed', 'status_changed'],
};

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function loadMockFile(url = '/mock_data.json'): Promise<MockFile> {
  const res = await fetch(url);
  if (!res.ok) throw new DataSourceError('network', `Could not load ${url} (${res.status}). Run "npm run sync-mock".`);
  return (await res.json()) as MockFile;
}

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;
  private opts: MockOptions;
  private ready: Promise<void> | null = null;
  private t!: Tables;
  private today!: string;
  private clock!: Date; // frozen BAMS mock clock
  private settings!: Settings;
  private auditSeq = 0;
  private backups: BackupInfo[] = [];
  private logs: string[] = [];
  private bamsEngine!: MockBams;
  private bamsImp!: MockBamsImport;
  private ops!: MockOperations;
  private port!: MockPortability;
  /** Test/dev hook: make the next N calls fail with a network error. */
  failNext = 0;
  private imports = new Map<string, { parsed: Parsed; fileName: string; size: number; format: ImportFormat; sheet: string | null; encoding: string | null; delimiter: string | null; notes: { code: string; text: string }[]; applied: ImportResult | null; skippedRaw: Map<number, Record<string, string>> }>();

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const file = this.opts.file ?? (await loadMockFile(this.opts.url));
        const realToday = !this.opts.today;
        this.today = this.opts.today ?? localToday();
        this.clock = this.opts.loadNow ?? (realToday ? new Date() : new Date(`${this.today}T12:00:00.000Z`));
        this.t = rebaseTables(file, { today: this.today, loadNow: this.clock });
        this.auditSeq = Math.max(0, ...this.t.audit_events.map((a) => a.id));
        const m = Object.fromEntries(file.app_meta.map((r) => [r.key, r.value]));
        this.settings = {
          default_landing: (m['setting.default_landing'] as Settings['default_landing']) ?? 'today',
          time_display: (m['setting.time_display'] as Settings['time_display']) ?? 'local',
          auto_refresh_minutes: (m['setting.auto_refresh_minutes'] as Settings['auto_refresh_minutes']) ?? '5',
          log_level: (m['setting.log_level'] as Settings['log_level']) ?? 'INFO',
          open_browser_on_start: m['setting.open_browser_on_start'] !== '0',
        };
        this.backups = [
          { name: 'tam_manual_backup.db', reason: 'manual', size_bytes: 1_048_576, created_at: addDays(this.today, -3) + 'T09:00:00.000Z' },
        ];
        this.bamsEngine = new MockBams({
          t: this.t, clock: this.clock, unavailable: this.opts.bamsProvider === 'unavailable', now: () => this.now(), uuid,
          audit: (a) => this.audit({ ...a, category: 'bams' }),
        });
        this.bamsImp = new MockBamsImport(this.bamsEngine, { t: this.t, now: () => this.now(), uuid, backup: () => { this.safetyBackup('pre-import'); return this.backups[0]; } });
        this.ops = new MockOperations({ t: this.t, today: () => this.today, now: () => this.now(), uuid, audit: (a) => this.audit({ ...a, category: 'operations' }), backup: () => this.safetyBackup('pre-delete') });
        this.port = new MockPortability({ t: this.t, now: () => this.now(), uuid, backups: () => this.backups, backup: () => { this.safetyBackup('pre-import'); return this.backups[0]; }, schema: 3 });
        this.log('INFO', `Mock data loaded; rebased to ${this.today}; BAMS mock clock ${this.clock.toISOString()}`);
      })();
    }
    return this.ready;
  }

  private async enter(): Promise<void> {
    await this.init();
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new DataSourceError('network', 'Mock failure injected (failNext).');
    }
  }

  private log(level: string, msg: string) {
    this.logs.push(`${new Date().toISOString()} ${level} ${msg}`);
    if (this.logs.length > 500) this.logs.shift();
  }

  private now(): string {
    return (this.opts.now ? this.opts.now() : new Date()).toISOString();
  }

  private midnight(): LocalMidnight {
    return this.opts.localMidnight ?? browserLocalMidnight;
  }

  // ------------------------------------------------------------------ audit

  private audit(a: {
    client_id: string | null;
    category?: string;
    object_type: string;
    object_id: string;
    object_label: string;
    action: string;
    old?: Row | null;
    new?: Row | null;
    reason?: string | null;
    source?: string;
  }) {
    this.t.audit_events.push({
      id: ++this.auditSeq,
      timestamp: this.now(),
      category: a.category ?? 'crm',
      client_id: a.client_id,
      object_type: a.object_type,
      object_id: a.object_id,
      object_label: a.object_label,
      action: a.action,
      old_value: a.old ? JSON.stringify(a.old) : null,
      new_value: a.new ? JSON.stringify(a.new) : null,
      reason: a.reason ?? null,
      source: a.source ?? 'GUI',
    });
  }

  private diff(oldR: Row, newR: Row, keys: string[]): { old: Row; new: Row } {
    const o: Row = {};
    const n: Row = {};
    for (const k of keys) if ((oldR[k] ?? null) !== (newR[k] ?? null)) { o[k] = oldR[k] ?? null; n[k] = newR[k] ?? null; }
    return { old: o, new: n };
  }

  private requireClient(id: string | null): Row | null {
    if (id == null) return null;
    const c = this.t.clients.find((x) => x.id === id);
    if (!c) throw new DataSourceError('validation_error', 'Account not found.', { client_id: 'Choose an existing account.' });
    return c;
  }

  private checkVersion(row: Row, expected: number | undefined, what: string) {
    if (expected !== undefined && row.row_version !== expected)
      throw new DataSourceError('stale_write', `This ${what} changed elsewhere. Reload it before saving.`);
  }

  private safetyBackup(reason: string) {
    this.backups.unshift({ name: `tam_${reason}_${Date.now()}.db`, reason, size_bytes: 1_048_576, created_at: this.now() });
    this.backups = this.backups.slice(0, 30);
    this.log('INFO', `Safety backup (${reason}) created`);
  }

  // ------------------------------------------------------------------ reads

  async getRuntime(): Promise<Runtime> {
    await this.enter();
    return {
      ok: true,
      mode: 'DEV',
      version: VERSION,
      schema_version: 1,
      db_path: 'in-memory mock data',
      backup_dir: '(mock; no files are written)',
      source: 'mock',
    };
  }

  async getState(): Promise<AppState> {
    await this.enter();
    const infra: AppState['infrastructure'] = {};
    for (const c of this.t.clients) infra[c.id] = infrastructureSummary(this.t, c.id, this.today);
    return {
      today: this.today,
      accounts: this.t.clients.map((c) => accountSummary(this.t, c, this.today)),
      tasks: this.t.tasks.filter((x) => !x.archived).map(toTask),
      contacts: this.t.contacts.map(toContact),
      infrastructure: infra,
      settings: { ...this.settings },
      runtime: await this.getRuntime(),
    };
  }

  async getToday(): Promise<TodayData> {
    await this.enter();
    const { queue, upcoming } = rankToday(this.t, this.today);
    const summaries = this.t.clients
      .filter((c) => c.status === 'Active')
      .map((c) => accountSummary(this.t, c, this.today));
    const load: AccountLoadRow[] = summaries
      .sort((a, b) => b.overdue - a.overdue || b.open_tasks - a.open_tasks || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((s) => ({
        client_id: s.id, client_name: s.name, open_tasks: s.open_tasks, overdue: s.overdue,
        waiting: s.waiting, active_alerts: s.active_alerts, next_contact: s.next_contact,
      }));
    return {
      today: this.today,
      queue,
      upcoming,
      recent_changes: this.recentChanges(20),
      account_load: load,
      progress: dayProgress(this.t, this.today, this.midnight()),
      generated_at: this.now(),
    };
  }

  async getActivityTrend(days = 14): Promise<ActivityTrend> {
    await this.enter();
    const bounds = trendBounds(this.today, days, this.midnight());
    const byClient = new Map<string, string[]>();
    const push = (id: string | null, ts: string) => {
      if (id == null) return;
      const list = byClient.get(id) ?? [];
      list.push(ts);
      byClient.set(id, list);
    };
    for (const n of this.t.notes) push(n.client_id, n.timestamp);
    for (const a of this.t.audit_events) {
      if (a.object_type === 'server_upgrade' || SYSTEM_AUDIT_ACTIONS[a.object_type]?.includes(a.action)) push(a.client_id, a.timestamp);
    }
    for (const b of this.bamsEvents()) push(b.client_id, b.ts);
    const series: Record<string, number[]> = {};
    for (const c of this.t.clients) {
      if (c.status !== 'Active') continue;
      series[c.id] = bucketCounts(byClient.get(c.id) ?? [], bounds);
    }
    return { today: this.today, days, series };
  }

  private recentChanges(limit: number): RecentChange[] {
    const clients = new Map<string, string>(this.t.clients.map((c) => [c.id, c.name]));
    const rows: RecentChange[] = [];
    for (const a of this.t.audit_events) {
      if (a.client_id == null || a.category === 'settings' || a.category === 'data') continue;
      const ok = RECENT_AUDIT_ACTIONS[a.object_type]?.includes(a.action) || a.object_type === 'server_upgrade';
      if (!ok) continue;
      rows.push({
        ts: a.timestamp, entry_key: `a:${String(a.id).padStart(12, '0')}`, client_id: a.client_id,
        client_name: clients.get(a.client_id) ?? null, object_type: a.object_type, object_id: a.object_id,
        sentence: auditSentence(a, this.today),
      });
    }
    for (const b of this.bamsEvents()) {
      rows.push({
        ts: b.ts, entry_key: b.entry_key, client_id: b.client_id, client_name: clients.get(b.client_id) ?? null,
        object_type: 'bams_alert_event', object_id: b.event_id, sentence: bamsSentence(b.what, b.subject, b.severity),
      });
    }
    rows.sort((a, b) => (a.ts === b.ts ? (a.entry_key < b.entry_key ? 1 : -1) : a.ts < b.ts ? 1 : -1));
    return rows.slice(0, limit);
  }

  private bamsEvents() {
    const out: { ts: string; entry_key: string; client_id: string; event_id: string; what: string; subject: string; severity: string; message: string | null; server: string; note: string | null; status: string }[] = [];
    const metrics = new Map<string, Row>(this.t.bams_metrics.map((m) => [m.id, m]));
    const objs = new Map<string, Row>(this.t.bams_objects.map((o) => [o.id, o]));
    for (const e of this.t.bams_alert_events) {
      const m = metrics.get(e.metric_id);
      const o = m && objs.get(m.object_id);
      if (!m || !o) continue;
      const base = { client_id: o.client_id, event_id: e.id, subject: `${o.name} · ${m.metric_name}`, severity: e.severity, message: e.message ?? null, server: o.name, note: e.closed_note ?? null, status: e.status };
      out.push({ ...base, ts: e.opened_at, entry_key: `b:${e.id}:opened`, what: 'opened' });
      if (e.recovered_at) out.push({ ...base, ts: e.recovered_at, entry_key: `b:${e.id}:recovered`, what: 'recovered' });
      if (e.closed_at) out.push({ ...base, ts: e.closed_at, entry_key: `b:${e.id}:closed`, what: 'closed' });
    }
    return out;
  }

  async getActivity(clientId: string, q: ActivityQuery): Promise<ActivityPage> {
    await this.enter();
    const needle = q.q?.trim().toLowerCase() || null;
    const has = (...vals: (string | null | undefined)[]) => !needle || vals.some((v) => v != null && v.toLowerCase().includes(needle));
    const entries: ActivityEntry[] = [];
    const wantNote = (type: string) =>
      q.filter === 'all' || (q.filter === 'meeting' && type === 'Meeting Note') || (q.filter === 'call' && type === 'Call Note') || (q.filter === 'general' && type === 'General Note');
    for (const n of this.t.notes) {
      if (n.client_id !== clientId || !wantNote(n.note_type)) continue;
      if (!has(n.subject, n.body, n.action_items)) continue;
      entries.push({ entry_kind: 'note', entry_key: `n:${n.id}`, ts: n.timestamp, note: toNote(n) });
    }
    if (q.filter === 'all' || q.filter === 'system') {
      for (const a of this.t.audit_events) {
        if (a.client_id !== clientId) continue;
        const ok = a.object_type === 'server_upgrade' || SYSTEM_AUDIT_ACTIONS[a.object_type]?.includes(a.action);
        if (!ok) continue;
        if (!has(a.object_label, a.old_value, a.new_value)) continue;
        entries.push({
          entry_kind: 'system', entry_key: `a:${String(a.id).padStart(12, '0')}`, ts: a.timestamp,
          object_type: a.object_type, object_id: a.object_id, sentence: auditSentence(a, this.today),
          source: a.source, severity: null, server_name: a.object_type === 'server_upgrade' ? a.object_label : null,
        });
      }
      for (const b of this.bamsEvents()) {
        if (b.client_id !== clientId || !has(b.message, b.server)) continue;
        entries.push({
          entry_kind: 'system', entry_key: b.entry_key, ts: b.ts, object_type: 'bams_alert_event', object_id: b.event_id,
          sentence: bamsSentence(b.what, b.subject, b.severity), source: 'System', severity: b.severity, server_name: b.server,
        });
      }
    }
    entries.sort((a, b) => (a.ts === b.ts ? (a.entry_key < b.entry_key ? 1 : -1) : a.ts < b.ts ? 1 : -1));
    let start = 0;
    if (q.cursor) {
      const [ts, key] = q.cursor.split('|');
      start = entries.findIndex((e) => e.ts < ts || (e.ts === ts && e.entry_key < key));
      if (start < 0) start = entries.length;
    }
    const limit = Math.min(q.limit ?? 50, 100);
    const items = entries.slice(start, start + limit);
    const more = start + limit < entries.length;
    const last = items[items.length - 1];
    return { items, next_cursor: more && last ? `${last.ts}|${last.entry_key}` : null };
  }

  async getTasks(query: TaskQuery): Promise<Task[]> {
    await this.enter();
    return this.t.tasks
      .filter((x) => (query.client_id ? x.client_id === query.client_id : true))
      .filter((x) => (query.archived === undefined ? true : !!x.archived === query.archived))
      .filter((x) => (query.status ? x.status === query.status : true))
      .map(toTask);
  }

  async getInfrastructure(clientId: string): Promise<Infrastructure> {
    await this.enter();
    if (!this.t.clients.some((c) => c.id === clientId)) throw new DataSourceError('not_found', 'Account not found.');
    return infrastructure(this.t, clientId, this.today, this.clock);
  }

  // ------------------------------------------------------------------ settings / data

  async getSettings(): Promise<Settings> {
    await this.enter();
    return { ...this.settings };
  }

  async saveSettings(patch: Partial<Settings>): Promise<MutationResult<Settings>> {
    await this.enter();
    const old = { ...this.settings };
    const next = { ...this.settings, ...patch };
    if (!['today', 'accounts', 'tasks'].includes(next.default_landing)) throw new DataSourceError('validation_error', 'Invalid landing page.', { default_landing: 'Invalid value.' });
    if (!['local', 'gmt'].includes(next.time_display)) throw new DataSourceError('validation_error', 'Invalid time display.', { time_display: 'Invalid value.' });
    if (!['off', '1', '5', '15'].includes(next.auto_refresh_minutes)) throw new DataSourceError('validation_error', 'Invalid refresh interval.', { auto_refresh_minutes: 'Invalid value.' });
    if (!['INFO', 'DEBUG'].includes(next.log_level)) throw new DataSourceError('validation_error', 'Invalid log level.', { log_level: 'Invalid value.' });
    for (const k of Object.keys(patch) as (keyof Settings)[]) {
      if (old[k] !== next[k])
        this.audit({ client_id: null, category: 'settings', object_type: 'setting', object_id: `setting.${k}`, object_label: `setting.${k}`, action: 'updated', old: { value: String(old[k]) }, new: { value: String(next[k]) } });
    }
    this.settings = next;
    return { item: { ...next }, side_effects: [] };
  }

  async getLogs(limit: number): Promise<string[]> {
    await this.enter();
    return this.logs.slice(-limit);
  }

  async createBackup(): Promise<BackupInfo> {
    await this.enter();
    const b: BackupInfo = { name: `tam_manual_${Date.now()}.db`, reason: 'manual', size_bytes: 1_048_576, created_at: this.now() };
    this.backups.unshift(b);
    this.audit({ client_id: null, category: 'data', object_type: 'backup', object_id: b.name, object_label: b.name, action: 'created', new: { reason: 'manual' } });
    this.log('INFO', `Manual backup ${b.name}`);
    return b;
  }

  async listBackups(): Promise<BackupInfo[]> {
    await this.enter();
    return this.backups.slice(0, 20);
  }

  // ------------------------------------------------------------------ accounts

  async saveAccount(input: AccountInput): Promise<MutationResult<Account>> {
    await this.enter();
    const errs = validateAccount(input);
    if (Object.keys(errs).length) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', errs);
    const name = clean(input.name)!;
    const dup = this.t.clients.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== input.id);
    if (dup) throw new DataSourceError('conflict', `An account named "${dup.name}" already exists.`, { name: 'An account with this name already exists.' });
    const ts = this.now();
    const side: string[] = [];
    if (!input.id) {
      if (!input.duplicates_confirmed) {
        const found = this.similarTo(name, clean(input.bpid));
        if (found.candidates.length) {
          throw new DataSourceError('possible_duplicate', 'A similar account already exists. Confirm it is a different account to create it.', undefined, 409, { candidates: found.candidates });
        }
      }
      const row: Row = {
        id: uuid(), name, status: input.status, bpid: clean(input.bpid), products: clean(input.products), contact: null,
        last_contact: null, next_contact: input.next_contact || null, notes: clean(input.notes),
        created_at: ts, updated_at: ts, row_version: 1,
      };
      this.t.clients.push(row);
      this.audit({ client_id: row.id, object_type: 'client', object_id: row.id, object_label: name, action: 'created', new: { bpid: row.bpid, name, status: row.status } });
      return { item: toAccount(row), side_effects: side };
    }
    const row = this.t.clients.find((c) => c.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Account not found.');
    this.checkVersion(row, input.expected_row_version, 'account');
    const before = { ...row };
    Object.assign(row, { name, status: input.status, bpid: clean(input.bpid), products: clean(input.products), next_contact: input.next_contact || null, notes: clean(input.notes) });
    const d = this.diff(before, row, ['name', 'bpid', 'products', 'notes']);
    if (Object.keys(d.new).length) this.audit({ client_id: row.id, object_type: 'client', object_id: row.id, object_label: row.name, action: 'updated', old: d.old, new: d.new });
    if (before.status !== row.status) this.audit({ client_id: row.id, object_type: 'client', object_id: row.id, object_label: row.name, action: 'status_changed', old: { status: before.status }, new: { status: row.status } });
    if (before.next_contact !== row.next_contact) {
      this.audit({ client_id: row.id, object_type: 'client', object_id: row.id, object_label: row.name, action: 'next_contact_changed', old: { next_contact: before.next_contact }, new: { next_contact: row.next_contact } });
      side.push('next_contact_changed');
    }
    row.row_version += 1;
    row.updated_at = ts;
    return { item: toAccount(row), side_effects: side };
  }

  async deleteAccount(input: { id: string; confirm: true; confirm_name: string }): Promise<void> {
    await this.enter();
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.');
    const row = this.t.clients.find((c) => c.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Account not found.');
    if (input.confirm_name !== row.name) throw new DataSourceError('confirmation_required', 'Type the exact account name to confirm.', { confirm_name: 'Does not match the account name.' });
    this.safetyBackup('pre-delete');
    const t = this.t;
    const objIds = new Set(t.bams_objects.filter((o) => o.client_id === row.id).map((o) => o.id));
    const metricIds = new Set(t.bams_metrics.filter((m) => objIds.has(m.object_id)).map((m) => m.id));
    const eventIds = new Set(t.bams_alert_events.filter((e) => metricIds.has(e.metric_id)).map((e) => e.id));
    t.bams_notification_log = t.bams_notification_log.filter((n) => !eventIds.has(n.event_id));
    t.bams_alert_events = t.bams_alert_events.filter((e) => !metricIds.has(e.metric_id));
    t.bams_alert_rules = t.bams_alert_rules.filter((r) => !metricIds.has(r.metric_id));
    t.bams_metric_samples = t.bams_metric_samples.filter((s) => !metricIds.has(s.metric_id));
    t.bams_metrics = t.bams_metrics.filter((m) => !objIds.has(m.object_id));
    t.bams_objects = t.bams_objects.filter((o) => o.client_id !== row.id);
    t.server_upgrades = t.server_upgrades.filter((u) => u.client_id !== row.id);
    t.contacts = t.contacts.filter((c) => c.client_id !== row.id);
    t.notes = t.notes.filter((n) => n.client_id !== row.id);
    t.tasks = t.tasks.filter((k) => k.client_id !== row.id);
    t.clients = t.clients.filter((c) => c.id !== row.id);
    this.audit({ client_id: row.id, object_type: 'client', object_id: row.id, object_label: row.name, action: 'deleted', old: { name: row.name, status: row.status } });
  }

  // ------------------------------------------------------------------ contacts

  async saveContact(input: ContactInput): Promise<MutationResult<Contact>> {
    await this.enter();
    const errs = validateContact(input);
    if (Object.keys(errs).length) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', errs);
    this.requireClient(input.client_id);
    const ts = this.now();
    const fields = { name: clean(input.name)!, role: clean(input.role), team: clean(input.team), email: clean(input.email) };
    let row: Row;
    let before: Row | null = null;
    if (!input.id) {
      row = { id: uuid(), client_id: input.client_id, ...fields, is_primary: 0, created_at: ts, updated_at: ts, row_version: 1 };
    } else {
      const found = this.t.contacts.find((c) => c.id === input.id);
      if (!found) throw new DataSourceError('not_found', 'Contact not found.');
      this.checkVersion(found, input.expected_row_version, 'contact');
      row = found;
      before = { ...found };
    }
    // Primary handling in one step: clear the old flag first, then set the new one.
    const prev = this.t.contacts.find((c) => c.client_id === input.client_id && c.is_primary && c.id !== row.id);
    const side: string[] = [];
    let message: string | undefined;
    if (input.is_primary && prev) {
      prev.is_primary = 0;
      prev.row_version += 1;
      prev.updated_at = ts;
      side.push('primary_cleared');
    }
    Object.assign(row, fields, { is_primary: input.is_primary ? 1 : 0 });
    if (!before) {
      this.t.contacts.push(row);
      this.audit({ client_id: row.client_id, object_type: 'contact', object_id: row.id, object_label: row.name, action: 'created', new: { name: row.name, role: row.role, team: row.team } });
    } else {
      const d = this.diff(before, row, ['name', 'role', 'team', 'email']);
      if (Object.keys(d.new).length) this.audit({ client_id: row.client_id, object_type: 'contact', object_id: row.id, object_label: row.name, action: 'updated', old: d.old, new: d.new });
      row.row_version += 1;
      row.updated_at = ts;
    }
    if (input.is_primary && (!before || !before.is_primary)) {
      this.audit({
        client_id: row.client_id, object_type: 'contact', object_id: row.id, object_label: row.name, action: 'primary_changed',
        old: prev ? { primary_contact: prev.name, primary_contact_id: prev.id } : null,
        new: { primary_contact: row.name, primary_contact_id: row.id },
      });
      message = prev ? `${row.name} is now primary (was ${prev.name})` : `${row.name} is now primary`;
    }
    return { item: toContact(row), side_effects: side, message };
  }

  async deleteContact(input: { id: string; confirm: true }): Promise<void> {
    await this.enter();
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.');
    const row = this.t.contacts.find((c) => c.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Contact not found.');
    this.safetyBackup('pre-delete');
    this.t.contacts = this.t.contacts.filter((c) => c.id !== row.id);
    this.audit({ client_id: row.client_id, object_type: 'contact', object_id: row.id, object_label: row.name, action: 'deleted', old: { name: row.name, role: row.role } });
  }

  // ------------------------------------------------------------------ tasks

  async saveTask(input: TaskInput): Promise<MutationResult<Task>> {
    await this.enter();
    const errs = validateTask(input);
    if (Object.keys(errs).length) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', errs);
    const client = this.requireClient(input.client_id);
    const ts = this.now();
    const f = {
      task: clean(input.task)!, client_id: input.client_id, category: input.category, priority: input.priority,
      due: input.due || null, next_update: input.next_update || null, status: input.status,
      waiting: clean(input.waiting), notes: clean(input.notes),
    };
    const side: string[] = [];
    let row: Row;
    if (!input.id) {
      row = { id: uuid(), ...f, archived: 0, created_at: ts, updated_at: ts, row_version: 1 };
      this.t.tasks.push(row);
      this.audit({ client_id: row.client_id, object_type: 'task', object_id: row.id, object_label: row.task, action: 'created', new: { due: row.due, priority: row.priority, status: row.status, task: row.task } });
    } else {
      const found = this.t.tasks.find((x) => x.id === input.id);
      if (!found) throw new DataSourceError('not_found', 'Task not found.');
      this.checkVersion(found, input.expected_row_version, 'task');
      row = found;
      const before = { ...found };
      Object.assign(row, f);
      const d = this.diff(before, row, ['task', 'client_id', 'category', 'priority', 'due', 'next_update', 'status', 'waiting', 'notes']);
      if (Object.keys(d.new).length) {
        let action = 'updated';
        if (before.status !== 'Complete' && row.status === 'Complete') action = 'completed';
        else if (before.status === 'Complete' && row.status !== 'Complete') action = 'reopened';
        const onlyStatus = action !== 'updated' && Object.keys(d.new).length === 1;
        this.audit({ client_id: row.client_id, object_type: 'task', object_id: row.id, object_label: row.task, action, old: onlyStatus ? { status: before.status } : d.old, new: onlyStatus ? { status: row.status } : d.new });
        row.row_version += 1;
        row.updated_at = ts;
      }
    }
    // D-07: Client Follow-Up may also set Next Client Touch (same transaction, own audit row).
    if (input.update_next_contact && row.category === 'Client Follow-Up' && client && row.due) {
      if (!client.next_contact || row.due < client.next_contact) {
        const old = client.next_contact;
        client.next_contact = row.due;
        client.row_version += 1;
        client.updated_at = ts;
        this.audit({ client_id: client.id, object_type: 'client', object_id: client.id, object_label: client.name, action: 'next_contact_changed', old: { next_contact: old }, new: { next_contact: row.due }, reason: 'Client Follow-Up task (D-07)', source: 'System' });
        side.push('next_contact_updated');
      }
    }
    return { item: toTask(row), side_effects: side };
  }

  async archiveTask(input: { id: string; archived: boolean; expected_row_version?: number }): Promise<MutationResult<Task>> {
    await this.enter();
    const row = this.t.tasks.find((x) => x.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Task not found.');
    this.checkVersion(row, input.expected_row_version, 'task');
    if (!!row.archived !== input.archived) {
      this.audit({ client_id: row.client_id, object_type: 'task', object_id: row.id, object_label: row.task, action: input.archived ? 'archived' : 'unarchived', old: { archived: row.archived }, new: { archived: input.archived ? 1 : 0 } });
      row.archived = input.archived ? 1 : 0;
      row.row_version += 1;
      row.updated_at = this.now();
    }
    return { item: toTask(row), side_effects: [] };
  }

  async deleteTask(input: { id: string; confirm: true }): Promise<void> {
    await this.enter();
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.');
    const row = this.t.tasks.find((x) => x.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Task not found.');
    this.safetyBackup('pre-delete');
    this.t.tasks = this.t.tasks.filter((x) => x.id !== row.id);
    this.audit({ client_id: row.client_id, object_type: 'task', object_id: row.id, object_label: row.task, action: 'deleted', old: { status: row.status, task: row.task } });
  }

  // ------------------------------------------------------------------ notes

  async getNote(id: string): Promise<Note | null> {
    await this.enter();
    const n = this.t.notes.find((x) => x.id === id);
    return n ? toNote(n) : null;
  }

  async saveNote(input: NoteInput): Promise<MutationResult<Note>> {
    await this.enter();
    const errs = validateNote(input);
    if (Object.keys(errs).length) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', errs);
    const client = this.requireClient(input.client_id)!;
    const ts = this.now();
    const f = { note_type: input.note_type, timestamp: new Date(input.timestamp).toISOString(), subject: clean(input.subject), body: clean(input.body), action_items: clean(input.action_items) };
    const side: string[] = [];
    let row: Row;
    if (!input.id) {
      row = { id: uuid(), client_id: input.client_id, ...f, source: 'GUI', created_at: ts, updated_at: ts, row_version: 1 };
      this.t.notes.push(row);
      this.audit({ client_id: row.client_id, object_type: 'note', object_id: row.id, object_label: row.subject ?? row.note_type, action: 'created', new: { note_type: row.note_type, subject: row.subject, timestamp: row.timestamp } });
    } else {
      const found = this.t.notes.find((n) => n.id === input.id);
      if (!found) throw new DataSourceError('not_found', 'Note not found.');
      this.checkVersion(found, input.expected_row_version, 'note');
      row = found;
      const before = { ...found };
      Object.assign(row, f);
      const d = this.diff(before, row, ['note_type', 'timestamp', 'subject', 'body', 'action_items']);
      if (Object.keys(d.new).length) {
        this.audit({ client_id: row.client_id, object_type: 'note', object_id: row.id, object_label: row.subject ?? row.note_type, action: 'updated', old: d.old, new: d.new });
        row.row_version += 1;
        row.updated_at = ts;
      }
    }
    // D-08: Meeting/Call notes later than last_contact move it forward (audited, source System).
    if (row.note_type !== 'General Note') {
      const day = instantLocalDate(row.timestamp);
      if (!client.last_contact || day > client.last_contact) {
        const old = client.last_contact;
        client.last_contact = day;
        client.row_version += 1;
        client.updated_at = ts;
        this.audit({ client_id: client.id, object_type: 'client', object_id: client.id, object_label: client.name, action: 'last_contact_changed', old: { last_contact: old }, new: { last_contact: day }, reason: 'Meeting/Call note saved (D-08)', source: 'System' });
        side.push('last_contact_updated');
      }
    }
    return { item: toNote(row), side_effects: side };
  }

  async deleteNote(input: { id: string; confirm: true }): Promise<void> {
    await this.enter();
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.');
    const row = this.t.notes.find((n) => n.id === input.id);
    if (!row) throw new DataSourceError('not_found', 'Note not found.');
    this.safetyBackup('pre-delete');
    this.t.notes = this.t.notes.filter((n) => n.id !== row.id);
    this.audit({ client_id: row.client_id, object_type: 'note', object_id: row.id, object_label: row.subject ?? row.note_type, action: 'deleted', old: { note_type: row.note_type, subject: row.subject, timestamp: row.timestamp } });
  }

  // ------------------------------------------------------------------ account import (D-37..D-48)

  private acctRecs(): AcctRec[] {
    return this.t.clients.map((c) => ({
      id: c.id as string, name: c.name as string, bpid: (c.bpid as string | null) ?? null, products: (c.products as string | null) ?? null,
      status: c.status as string, next_contact: (c.next_contact as string | null) ?? null, notes: (c.notes as string | null) ?? null, row_version: c.row_version as number,
    }));
  }

  private similarTo(name: string, bpid: string | null): SimilarCheck {
    const key = exactKey(name);
    const recs = this.acctRecs();
    const ex = recs.find((a) => exactKey(a.name) === key) ?? null;
    const list: (SimilarCandidate & { id: string })[] = [];
    for (const a of recs) {
      if (ex && a.id === ex.id) continue;
      const h = compare({ name, bpid }, { name: a.name, bpid: a.bpid });
      if (h) list.push({ id: a.id, ref: { type: 'account', id: a.id }, name: a.name, bpid: a.bpid, products: a.products, status: a.status, next_contact: a.next_contact, row_version: a.row_version, ...h, fills: {}, kept: {}, notes: [] });
    }
    const candidates = orderHits(list).map(({ id: _id, ...c }) => { void _id; return c as SimilarCandidate; });
    return { exact: ex ? { id: ex.id, name: ex.name, status: ex.status, row_version: ex.row_version } : null, candidates };
  }

  async checkSimilarAccount(input: { name: string; bpid: string | null }): Promise<SimilarCheck> {
    await this.enter();
    const name = clean(input.name);
    if (!name || name.length > 200) throw new DataSourceError('validation_error', 'Fix the highlighted fields.', { name: 'Account name is required (200 characters or fewer).' });
    return this.similarTo(name, clean(input.bpid));
  }

  private session(id: string) {
    const s = this.imports.get(id);
    if (!s) throw new DataSourceError('import_expired', 'This import timed out. Choose the file again.', undefined, 410);
    return s;
  }

  private planFor(id: string): ImportPlan {
    const s = this.session(id);
    const exp = new Date(Date.parse(this.now()) + 60 * 60_000).toISOString();
    return buildPlan(s.parsed, this.acctRecs(), { name: s.fileName, size_bytes: s.size, format: s.format, sheet: s.sheet, encoding: s.encoding, delimiter: s.delimiter, extraNotes: s.notes.map((n) => n.text) }, id, exp);
  }

  async inspectAccountsImport(file: File): Promise<ImportPlan> {
    await this.enter();
    const refuse = (e: FileRefusal) => new DataSourceError('invalid_file', e.message, undefined, 422, { reason: e.reason, ...e.extra });
    if (file.size > MAX_BYTES) throw refuse(new FileRefusal('too_large', 'This file is larger than 5 MB. Split it and import it in parts.'));
    try {
      const bytes = await readBytes(file);
      const kind = sniff(file.name, bytes);
      let parsed: Parsed;
      let sheet: string | null = null;
      let encoding: string | null = null;
      let delimiter: string | null = null;
      const notes = kind.notes.map((text) => ({ code: 'format_mismatch', text }));
      if (kind.format === 'xlsx') {
        const x = await parseXlsx(bytes);
        sheet = x.sheet;
        parsed = parseGrid(x.grid);
      } else {
        const c = parseCsv(bytes);
        sheet = 'CSV';
        encoding = c.encoding;
        delimiter = c.delimiter;
        parsed = parseGrid(c.grid);
        notes.push({ code: 'csv_read', text: `Read as CSV: encoding ${c.encoding}, delimiter ${c.delimiter}.` });
      }
      if (this.imports.size >= 3) this.imports.delete(this.imports.keys().next().value as string);
      const id = uuid();
      this.imports.set(id, { parsed, fileName: file.name.replace(/^.*[\\/]/, '').slice(0, 200), size: file.size, format: kind.format, sheet, encoding, delimiter, notes, applied: null, skippedRaw: new Map() });
      return this.planFor(id);
    } catch (e) {
      if (e instanceof FileRefusal) throw refuse(e);
      throw e;
    }
  }

  async getAccountsImport(importId: string): Promise<ImportPlan> {
    await this.enter();
    return this.planFor(importId);
  }

  async applyAccountsImport(input: ImportApplyInput): Promise<ImportResult> {
    await this.enter();
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.');
    const s = this.session(input.import_id);
    if (s.applied) throw new DataSourceError('already_applied', 'This import was already applied.', undefined, 409, { result: s.applied });
    const plan = this.planFor(input.import_id);
    const chk = checkDecisions(plan, input.decisions);
    if (chk.invalid) throw new DataSourceError('validation_error', chk.invalid, undefined, 422);
    if (chk.unresolved.length) throw new DataSourceError('unresolved_duplicates', `${chk.unresolved.length} similar ${chk.unresolved.length === 1 ? 'row needs' : 'rows need'} a decision.`, undefined, 409, { rows: chk.unresolved });
    if (plan.plan_hash !== input.plan_hash) throw new DataSourceError('preview_stale', 'Accounts changed since the preview was made.', undefined, 409, { changed: [] });
    const fx = computeEffects(plan, input.decisions, this.acctRecs());
    const total = fx.creates.length + fx.updates.length;
    let backup: ImportResult['backup'] = null;
    if (total > 0) {
      this.safetyBackup('pre-import');
      const b = this.backups[0];
      backup = { name: b.name, reason: 'pre-import', size_bytes: b.size_bytes };
    }
    const ts = this.now();
    const reason = (name: string, rows: number[]) => `Bulk import: ${name}, row${rows.length > 1 ? 's' : ''} ${rows.join(', ')}`;
    const created: ImportResult['created'] = [];
    for (const c of fx.creates) {
      const v = c.values;
      const row: Row = { id: uuid(), name: v.name, status: v.status ?? 'Active', bpid: v.bpid, products: v.products, contact: null, last_contact: null, next_contact: v.next_contact, notes: v.notes, created_at: ts, updated_at: ts, row_version: 1 };
      this.t.clients.push(row);
      this.audit({ client_id: row.id as string, object_type: 'client', object_id: row.id as string, object_label: v.name!, action: 'created', new: { bpid: row.bpid, name: v.name, status: row.status }, reason: reason(s.fileName, c.rows), source: 'Bulk Import' });
      created.push({ id: row.id as string, name: v.name!, rows: c.rows });
    }
    const updated: ImportResult['updated'] = [];
    let filled = 0;
    for (const u of fx.updates) {
      const row = this.t.clients.find((x) => x.id === u.id)!;
      const old: Row = {};
      for (const k of Object.keys(u.fills)) { old[k] = row[k] ?? null; row[k] = u.fills[k]; }
      row.row_version = (row.row_version as number) + 1;
      row.updated_at = ts;
      filled += Object.keys(u.fills).length;
      this.audit({ client_id: u.id, object_type: 'client', object_id: u.id, object_label: row.name as string, action: 'updated', old, new: { ...u.fills }, reason: reason(s.fileName, u.rows), source: 'Bulk Import' });
      updated.push({ id: u.id, name: row.name as string, rows: u.rows, filled: Object.keys(u.fills) });
    }
    const result: ImportResult = {
      import_id: input.import_id, applied_at: ts, file: { name: s.fileName, rows_found: plan.counts.rows, format: s.format },
      counts: { created: created.length, updated: updated.length, unchanged: fx.unchanged, skipped: fx.skipped.length, invalid: plan.counts.invalid, overwritten: 0 },
      breakdown: fx.breakdown, fields_filled: filled, audit_events: created.length + updated.length, backup, created, updated, skipped: fx.skipped,
    };
    for (const r of plan.rows) if (r.state === 'invalid' && r.raw) s.skippedRaw.set(r.row, r.raw);
    s.applied = result;
    this.log('INFO', `Bulk import applied: ${s.fileName}; created ${created.length}, updated ${updated.length}, skipped ${fx.skipped.length}`);
    return result;
  }

  async downloadImportTemplate(format: ImportFormat): Promise<DownloadedFile> {
    await this.enter();
    const example = ['Example Capital Partners', '100123', 'Terminal', 'Active', '2026-11-05', 'Delete this example row'];
    if (format === 'csv') return { blob: toCsv([[...COLUMNS], example]), filename: 'tam_accounts_import_template.csv' };
    return { blob: xlsxBlob([[...COLUMNS]]), filename: 'tam_accounts_import_template.xlsx' };
  }

  async downloadSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile> {
    await this.enter();
    const s = this.session(importId);
    if (!s.applied) throw new DataSourceError('conflict', 'This import has not been applied yet.', undefined, 409);
    if (format !== s.format) throw new DataSourceError('not_found', 'The skipped-rows file is only available in the format of the upload.', undefined, 404);
    const fmt = s.format;
    const plan = this.planFor(importId);
    const byRow = new Map(plan.rows.map((r) => [r.row, r]));
    const head = [...COLUMNS, 'Source row', 'Reason', 'Possible duplicate of'];
    const body = s.applied.skipped.map((k) => {
      const r = byRow.get(k.row);
      const v = r?.values;
      const raw = s.skippedRaw.get(k.row);
      const g = (f: 'name' | 'bpid' | 'products' | 'status' | 'next_contact' | 'notes') => raw?.[f] ?? v?.[f] ?? '';
      const dup = /possible duplicate of (.+)\)$/.exec(k.reason)?.[1] ?? '';
      return [g('name'), g('bpid'), g('products'), g('status'), g('next_contact'), g('notes'), String(k.row), k.reason, dup];
    });
    const rows = [head, ...body];
    if (fmt === 'csv') return { blob: toCsv(rows), filename: 'tam_accounts_skipped.csv' };
    return { blob: xlsxBlob(rows), filename: 'tam_accounts_skipped.xlsx' };
  }

  // ------------------------------------------------------------------ BAMS (contract §11, §12)

  async getBamsState(q: BamsStateQuery): Promise<BamsState> { await this.enter(); return this.bamsEngine.getState(q); }
  async getBamsMetric(id: string): Promise<BamsMetricDetail> { await this.enter(); return this.bamsEngine.getMetric(id); }
  async getBamsTrend(id: string, range: TrendRange): Promise<BamsTrend> { await this.enter(); return this.bamsEngine.getTrend(id, range); }
  async getBamsAlerts(q: { status?: AlertListStatus; account?: string; metric_id?: string; limit?: number }): Promise<BamsAlertList> { await this.enter(); return this.bamsEngine.getAlerts(q); }
  async closeBamsAlert(input: { id: string; note: string | null }): Promise<{ event: BamsAlertEvent; suppressed_until_clear: boolean }> { await this.enter(); return this.bamsEngine.closeAlert(input.id, input.note); }
  async setBamsMonitor(run: boolean): Promise<{ monitor: BamsMonitor }> { await this.enter(); this.bamsEngine.desiredRunning = run; return { monitor: this.bamsEngine.monitor() }; }
  async getBamsMonitor(): Promise<{ monitor: BamsMonitor; provider: BamsProvider }> { await this.enter(); return { monitor: this.bamsEngine.monitor(), provider: this.bamsEngine.provider() }; }
  async getBamsSettings(): Promise<BamsSettings> { await this.enter(); return { ...this.bamsEngine.settings }; }
  async saveBamsSettings(patch: Partial<BamsSettings>): Promise<BamsSettings> { await this.enter(); return this.bamsEngine.saveSettings(patch); }
  async saveBamsObject(input: BamsObjectInput): Promise<MutationResult<BamsObjectSaved>> { await this.enter(); return { item: this.bamsEngine.saveObject(input), side_effects: [] }; }
  async saveBamsMetric(input: BamsMetricInput & { object_id?: string }): Promise<void> { await this.enter(); this.bamsEngine.saveMetric(input); }
  async getBamsDeletePreview(kind: 'object' | 'metric', id: string): Promise<BamsDeletePreview> { await this.enter(); return this.bamsEngine.deletePreview(kind, id); }
  async deleteBamsItem(kind: 'object' | 'metric', input: { id: string }): Promise<BamsDeleteResult> { await this.enter(); this.safetyBackup('pre-delete'); return this.bamsEngine.deleteItem(kind, input.id); }
  async saveBamsRule(input: BamsRuleInput): Promise<BamsRule> { await this.enter(); return this.bamsEngine.saveRule(input); }
  async deleteBamsRule(input: { id: string }): Promise<void> { await this.enter(); this.bamsEngine.deleteRule(input.id); }
  async getBamsConfigs(): Promise<BamsConfig[]> { await this.enter(); return this.bamsEngine.getConfigs(); }
  async previewBamsConfig(input: { config_id: string; metric_ids?: string[] | null }): Promise<BamsConfigPreview> { await this.enter(); return this.bamsEngine.previewConfig(input.config_id, input.metric_ids); }
  async applyBamsConfig(input: { config_id: string; metric_ids?: string[] | null; plan_hash: string }): Promise<BamsConfigApplied> { await this.enter(); return this.bamsEngine.applyConfig(input.config_id, input.plan_hash, input.metric_ids); }
  async getBamsNotifications(limit = 30): Promise<BamsNotifications> { await this.enter(); return this.bamsEngine.getNotifications(limit); }
  async markBamsNotificationsRead(input: { through_id: number } | { all: true }): Promise<number> { await this.enter(); return this.bamsEngine.markRead(input); }

  async inspectBamsImport(file: File): Promise<BamsImportPlan> {
    await this.enter();
    const refuse = (e: FileRefusal) => new DataSourceError('invalid_file', e.message, undefined, 422, { reason: e.reason, ...e.extra });
    if (file.size > MAX_BYTES) throw refuse(new FileRefusal('too_large', 'This file is larger than 5 MiB. Split it and import it in parts.'));
    try {
      const bytes = await readBytes(file);
      const kind = sniff(file.name, bytes);
      let grid;
      let sheet: string | null = 'Import';
      let encoding: string | null = null;
      let delimiter: string | null = null;
      if (kind.format === 'xlsx') { const x = await parseXlsx(bytes); grid = x.grid; sheet = x.sheet; } else { const c = parseCsv(bytes); grid = c.grid; sheet = null; encoding = c.encoding; delimiter = c.delimiter; }
      return this.bamsImp.create(parseBamsGrid(grid), { name: file.name.replace(/^.*[\\/]/, '').slice(0, 200), size: file.size, format: kind.format, sheet, encoding, delimiter, notes: kind.notes });
    } catch (e) {
      if (e instanceof FileRefusal) throw refuse(e);
      throw e;
    }
  }
  async getBamsImport(importId: string): Promise<BamsImportPlan> { await this.enter(); return this.bamsImp.plan(importId); }
  async applyBamsImport(input: BamsApplyInput): Promise<BamsImportResult> { await this.enter(); return this.bamsImp.apply(input); }
  async downloadBamsImportTemplate(format: ImportFormat): Promise<DownloadedFile> {
    await this.enter();
    const rows = bamsTemplateRows();
    return format === 'csv' ? { blob: toCsv([rows[0]]), filename: 'tam_bams_import_template.csv' } : { blob: xlsxBlob(rows), filename: 'tam_bams_import_template.xlsx' };
  }
  async downloadBamsSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile> {
    await this.enter();
    const rows = this.bamsImp.skippedRows(importId, format);
    return format === 'csv' ? { blob: toCsv(rows), filename: 'tam_bams_skipped.csv' } : { blob: xlsxBlob(rows), filename: 'tam_bams_skipped.xlsx' };
  }

  // ------------------------------------------------------------------ Operations (contract section 13)

  async getOperations(q: OpsQuery): Promise<OpsData> { await this.enter(); return this.ops.get(q); }
  async saveOperationsQuarter(input: OpsQuarterInput): Promise<OpsQuarter> { await this.enter(); return this.ops.saveQuarter(input); }
  async deleteOperationsQuarter(input: { year: number; quarter: OpsQuarterName; confirm: boolean }): Promise<void> { await this.enter(); this.ops.deleteQuarter(input); }
  async saveOperationsAppliance(input: OpsApplianceInput): Promise<OpsRow> { await this.enter(); return this.ops.saveAppliance(input); }
  async resetOperationsAppliance(input: { object_id: string; year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): Promise<OpsRow> { await this.enter(); return this.ops.resetAppliance(input); }
  async setOperationsVersion(input: { year: number; quarter: OpsQuarterName; object_ids: string[]; target_version: string | null }): Promise<OpsSetVersionResult> { await this.enter(); return this.ops.setVersion(input); }

  // ------------------------------------------------------------------ Portability (contract section 14)

  async exportExcel(): Promise<DownloadedFile> { await this.enter(); return { blob: new Blob(['mock export'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename: 'tam_export_mock.xlsx' }; }
  async exportDatabase(): Promise<DownloadedFile> { await this.enter(); return { blob: new Blob(['SQLite format 3\0mock'], { type: 'application/vnd.sqlite3' }), filename: 'tam_backup_mock_v3.db' }; }
  async inspectRestoreFile(file: File, opts: { session?: string; table?: string } = {}): Promise<RestorePlan> { await this.enter(); return this.port.inspect(file, opts); }
  async getRestorePlan(id: string, q: RestoreIssueQuery = {}): Promise<RestorePlan> { await this.enter(); return this.port.get(id, q); }
  async removeRestoreFile(id: string, fileId: string): Promise<RestorePlan> { await this.enter(); return this.port.remove(id, fileId); }
  async setRestoreTable(id: string, fileId: string, table: string): Promise<RestorePlan> { await this.enter(); return this.port.setTable(id, fileId, table); }
  async applyRestore(input: { restore_id: string; plan_hash: string }): Promise<RestoreResult> { await this.enter(); return this.port.apply(input); }
  async downloadRestoreSkipped(id: string, format: ImportFormat): Promise<DownloadedFile> { await this.enter(); this.port.skipped(id); return { blob: new Blob(['table,source_row,outcome,reason,values\n']), filename: `tam_restore_skipped.${format}` }; }
  async inspectDatabaseRestore(file: File): Promise<DbRestorePreview> { await this.enter(); return this.port.inspectDb(file); }
  async previewBackupRestore(name: string): Promise<DbRestorePreview> { await this.enter(); return this.port.fromBackup(name); }
  async cancelDatabaseRestore(id: string): Promise<void> { await this.enter(); this.port.cancelDb(id); }
  async applyDatabaseRestore(input: { restore_id: string; confirm: string }): Promise<DbRestoreResult> { await this.enter(); return this.port.applyDb(input); }
}

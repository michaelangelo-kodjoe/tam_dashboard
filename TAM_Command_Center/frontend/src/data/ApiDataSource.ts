// ApiDataSource: HTTP adapter for the FastAPI backend (Phase 4.1 swap target).
// Aligned with docs/04_API_CONTRACT.md (frozen for run 1). It is a thin mapper: wire shapes
// (nested `counts`, `kind`-tagged activity entries, object side effects, `{settings: ...}`
// bodies) are converted to the domain types in src/types.ts so no component changes when the
// adapter is swapped. This module (with MockDataSource's JSON loader) is the only place that
// calls fetch. NOT yet exercised against the live backend (Phase 4.1); contract-shaped
// payloads are covered by ApiDataSource.test.ts.
import type {
  Account, AccountInput, AccountSummary, ActivityEntry, ActivityPage, ActivityTrend, AppState, BackupInfo, BamsObject, Contact,
  ContactInput, Freshness, Infrastructure, InfrastructureSummary, MutationResult, Note, NoteInput, QueueItem, RecentChange,
  Runtime, ServerTile, ServerUpgrade, Settings, Task, TaskInput, TaskQuery, TodayData, TodayProgress,
} from '../types';
import type {
  CandidateRef, DownloadedFile, ImportApplyInput, ImportFormat, ImportPlan, ImportResult, ImportRow, ImportValues, ReasonText, SimilarCandidate, SimilarCheck,
} from '../types';
import type {
  AlertListStatus, BamsAlertEvent, BamsAlertList, BamsApplyInput, BamsConfig, BamsConfigApplied, BamsConfigPreview, BamsDeletePreview, BamsDeleteResult,
  BamsImportPlan, BamsImportResult, BamsMetricDetail, BamsMetricInput, BamsMonitor, BamsNotifications, BamsObjectInput, BamsObjectSaved, BamsProvider, BamsRow, BamsRule,
  BamsRuleInput, BamsSettings, BamsState, BamsStateQuery, BamsTrend, TrendRange,
} from '../bamsTypes';
import type { DbRestorePreview, DbRestoreResult, RestoreIssueQuery, RestorePlan, RestoreResult } from '../portTypes';
import type { OpsApplianceInput, OpsData, OpsQuarter, OpsQuarterInput, OpsQuarterName, OpsQuery, OpsRow, OpsSetVersionResult } from '../opsTypes';
import { FileRefusal, MAX_BYTES, readBytes, sniff } from './importFile';
import { DataSourceError, type ActivityQuery, type DataSource, type ErrorCode } from './DataSource';

type Json = Record<string, unknown>;

// ---- wire shapes (docs/04_API_CONTRACT.md) ----------------------------------------------
interface WireAccount extends Omit<Account, never> {
  counts: { open_tasks: number; overdue: number; waiting: number; active_alerts: number; next_upgrade: string | null; upcoming_upgrades: number; servers: number };
}
interface WireInfra {
  client_id?: string;
  servers: number; // distinct server count (frozen); the tiles are `server_tiles` (contract §9.3)
  server_tiles?: WireServerTile[];
  active_alerts: number;
  environment_summary: Record<string, number | string[]>;
  bams_objects: (Omit<BamsObject, 'active_alerts'> & { alerts?: { status: string }[] })[];
  server_upgrades: ServerUpgrade[];
  next_upgrade: { date: string; server: string } | null;   // FE-AC-4: server-computed
}
interface WireServerTile {
  name: string;
  environment?: string | null;
  version?: string | null;
  alert_severity?: ServerTile['alert_severity'];
  spark?: { metric: string; window_hours: number; points: [string, number][] } | null;
}
type WireSideEffect = { type: string; name?: string; contact_id?: string };
interface WireMutation<T> { ok: true; item: T; side_effects?: WireSideEffect[] }
type WireActivity =
  | { kind: 'note'; entry_key: string; ts: string; id: string; client_id: string; created_at: string; note_type: Note['note_type']; subject: string | null; body: string | null; action_items: string | null; source: string; row_version: number; updated_at: string }
  | { kind: 'system'; entry_key: string; ts: string; event_type: string; object_type: string; object_id: string; label: string | null; severity: string | null; source: string; sentence: string; server_name: string | null };

// ---- mappers (exported for tests) -------------------------------------------------------
export function mapAccount(a: WireAccount): AccountSummary {
  const { counts, ...rest } = a;
  return { ...rest, ...counts };
}

/** Per-server tiles (contract §9.3, `server_tiles`; absent on older servers). A tile without a series gets spark = null. */
export function mapServers(w: WireInfra): ServerTile[] {
  const list = w.server_tiles ?? [];
  return list.map((t) => ({
    name: t.name,
    environment: t.environment ?? null,
    version: t.version ?? null,
    alert_severity: t.alert_severity ?? null,
    spark: t.spark && Array.isArray(t.spark.points) && t.spark.points.length > 0 ? { metric: t.spark.metric, window_hours: t.spark.window_hours, points: t.spark.points } : null,
  }));
}

export function mapProgress(p: TodayProgress | null | undefined): TodayProgress | null {
  if (!p || typeof p.total !== 'number' || typeof p.done !== 'number') return null;
  return { day: p.day, total: p.total, done: p.done, open: p.open, done_other: p.done_other ?? 0 };
}

export function mapInfraSummary(w: WireInfra): InfrastructureSummary {
  const env = w.environment_summary ?? {};
  const parts = Object.entries(env)
    .filter(([k, v]) => k !== 'regions' && k !== 'unknown' && typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k} ${v}`);
  if (typeof env.unknown === 'number' && env.unknown > 0) parts.push(`Unknown ${env.unknown}`);
  return {
    servers: w.servers,
    active_alerts: w.active_alerts,
    next_upgrade: w.next_upgrade ?? null,
    env_summary: parts.join(' · '),
    regions: Array.isArray(env.regions) ? (env.regions as string[]) : [],
  };
}

export function mapInfra(w: WireInfra & { client_id: string }): Infrastructure {
  return {
    client_id: w.client_id,
    bams_objects: w.bams_objects.map((o) => ({
      id: o.id, client_id: o.client_id, name: o.name, region: o.region, location: o.location, environment: o.environment,
      enabled: !!o.enabled, worst_status: o.worst_status as Freshness, metric_count: o.metric_count, active_alerts: o.alerts?.length ?? 0,
    })),
    upgrades: w.server_upgrades,
    summary: mapInfraSummary(w),
    servers: mapServers(w),
  };
}

export function mapActivity(e: WireActivity): ActivityEntry {
  if (e.kind === 'note') {
    return {
      entry_kind: 'note', entry_key: e.entry_key, ts: e.ts,
      note: {
        id: e.id, client_id: e.client_id, note_type: e.note_type, timestamp: e.ts, subject: e.subject, body: e.body, action_items: e.action_items,
        source: e.source, created_at: e.created_at, updated_at: e.updated_at, row_version: e.row_version,
      },
    };
  }
  return {
    entry_kind: 'system', entry_key: e.entry_key, ts: e.ts, object_type: e.object_type, object_id: e.object_id,
    sentence: e.sentence, source: e.source, severity: e.severity, server_name: e.server_name ?? null,
  };
}

function effects(list: WireSideEffect[] | undefined): string[] {
  return (list ?? []).map((s) => s.type);
}

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;
  constructor(private base = '') {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new DataSourceError('network', 'Could not reach the TAM Command Center server. Check that it is running.');
    }
    let json: Json | null = null;
    try {
      json = (await res.json()) as Json;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || (json && json.ok === false)) {
      const err = (json?.error ?? {}) as { code?: ErrorCode; message?: string; fields?: Record<string, string>; details?: Record<string, unknown> };
      throw new DataSourceError(err.code ?? 'internal', err.message ?? `Request failed (${res.status}).`, err.fields, res.status, err.details);
    }
    return json as T;
  }

  /** Binary upload / download helper (the only non-JSON transport; stays inside src/data). */
  private async rawRequest(method: 'GET' | 'POST', path: string, body?: Uint8Array | Blob, headers?: Record<string, string>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.base + path, { method, headers, body: body as BodyInit | undefined });
    } catch {
      throw new DataSourceError('network', 'Could not reach the TAM Command Center server. Check that it is running.');
    }
    if (!res.ok) {
      let json: Json | null = null;
      try { json = (await res.json()) as Json; } catch { /* not JSON */ }
      const err = (json?.error ?? {}) as { code?: ErrorCode; message?: string; fields?: Record<string, string>; details?: Record<string, unknown> };
      const code: ErrorCode = err.code ?? (res.status === 413 ? 'payload_too_large' : 'internal');
      throw new DataSourceError(code, err.message ?? `Request failed (${res.status}).`, err.fields, res.status, err.details);
    }
    return res;
  }

  private async download(path: string, fallback: string): Promise<DownloadedFile> {
    const res = await this.rawRequest('GET', path);
    const cd = res.headers.get('Content-Disposition') ?? '';
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1];
    return { blob: await res.blob(), filename: filename ? decodeURIComponent(filename) : fallback };
  }

  private qs(params: Record<string, string | number | boolean | undefined | null>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  private task = (t: Task): Task => ({ ...t, archived: !!t.archived });
  private contact = (c: Contact): Contact => ({ ...c, is_primary: !!c.is_primary });

  async getRuntime(): Promise<Runtime> {
    const h = await this.request<Json>('GET', '/api/health');
    return { ok: true, mode: h.mode as Runtime['mode'], version: String(h.version), schema_version: Number(h.schema_version), db_path: String(h.db_path), source: 'api' };
  }

  async getState(): Promise<AppState> {
    const s = await this.request<{
      today: string; runtime: Runtime; settings: Settings; accounts: WireAccount[]; tasks: Task[]; contacts: Contact[]; infrastructure: Record<string, WireInfra>;
    }>('GET', '/api/state');
    const infra: Record<string, InfrastructureSummary> = {};
    for (const [id, w] of Object.entries(s.infrastructure)) infra[id] = mapInfraSummary(w);
    return {
      today: s.today,
      accounts: s.accounts.map(mapAccount),
      tasks: s.tasks.map(this.task),
      contacts: s.contacts.map(this.contact),
      infrastructure: infra,
      settings: s.settings,
      runtime: { ...s.runtime, ok: true, source: 'api' },
    };
  }

  async getToday(): Promise<TodayData> {
    const t = await this.request<{ today: string; queue: QueueItem[]; upcoming: QueueItem[]; recent_changes: RecentChange[]; account_load: TodayData['account_load']; progress?: TodayProgress }>('GET', '/api/today');
    return {
      today: t.today, queue: t.queue, upcoming: t.upcoming, recent_changes: t.recent_changes, account_load: t.account_load,
      progress: mapProgress(t.progress), generated_at: new Date().toISOString(),
    };
  }

  async getActivityTrend(days = 14): Promise<ActivityTrend> {
    const r = await this.request<{ today: string; days: number; series: Record<string, number[]> }>('GET', `/api/accounts/activity-trend${this.qs({ days })}`);
    return { today: r.today, days: r.days, series: r.series };
  }

  async getActivity(clientId: string, q: ActivityQuery): Promise<ActivityPage> {
    const r = await this.request<{ items: WireActivity[]; next_cursor: string | null }>(
      'GET',
      `/api/client/${encodeURIComponent(clientId)}/activity${this.qs({ filter: q.filter, q: q.q, before: q.cursor, limit: q.limit })}`,
    );
    return { items: r.items.map(mapActivity), next_cursor: r.next_cursor };
  }

  async getTasks(query: TaskQuery): Promise<Task[]> {
    const r = await this.request<{ items: Task[] }>(
      'GET',
      `/api/tasks${this.qs({ client_id: query.client_id, archived: query.archived === undefined ? undefined : query.archived ? 'true' : 'false', status: query.status })}`,
    );
    return r.items.map(this.task);
  }

  async getInfrastructure(clientId: string): Promise<Infrastructure> {
    const w = await this.request<WireInfra & { client_id: string }>('GET', `/api/client/${encodeURIComponent(clientId)}/infrastructure`);
    return mapInfra(w);
  }

  async getSettings(): Promise<Settings> {
    return (await this.request<{ settings: Settings }>('GET', '/api/settings')).settings;
  }
  async saveSettings(patch: Partial<Settings>): Promise<MutationResult<Settings>> {
    const r = await this.request<WireMutation<Settings>>('POST', '/api/settings/save', { settings: patch });
    return { item: r.item, side_effects: effects(r.side_effects) };
  }
  async getLogs(limit: number): Promise<string[]> {
    return (await this.request<{ lines: string[] }>('GET', `/api/logs/recent?limit=${limit}`)).lines;
  }
  async createBackup(): Promise<BackupInfo> {
    return (await this.request<{ item: BackupInfo }>('POST', '/api/data/backup', {})).item;
  }
  async listBackups(): Promise<BackupInfo[]> {
    return (await this.request<{ items: BackupInfo[] }>('GET', '/api/data/backups?limit=20')).items;
  }

  async saveAccount(input: AccountInput): Promise<MutationResult<Account>> {
    const r = await this.request<WireMutation<WireAccount>>('POST', '/api/client/save', input);
    const { counts: _counts, ...account } = r.item;
    void _counts;
    return { item: account, side_effects: effects(r.side_effects) };
  }
  async deleteAccount(input: { id: string; confirm: true; confirm_name: string }): Promise<void> {
    await this.request('POST', '/api/client/delete', input);
  }

  async saveContact(input: ContactInput): Promise<MutationResult<Contact>> {
    // client_id is immutable after creation, so it is only sent on create
    const body = input.id ? { ...input, client_id: undefined } : input;
    const r = await this.request<WireMutation<Contact>>('POST', '/api/contact/save', body);
    const item = this.contact(r.item);
    const cleared = (r.side_effects ?? []).find((s) => s.type === 'primary_cleared');
    return { item, side_effects: effects(r.side_effects), message: cleared && item.is_primary ? `${item.name} is now primary (was ${cleared.name})` : undefined };
  }
  async deleteContact(input: { id: string; confirm: true }): Promise<void> {
    await this.request('POST', '/api/contact/delete', input);
  }

  async saveTask(input: TaskInput): Promise<MutationResult<Task>> {
    const r = await this.request<WireMutation<Task>>('POST', '/api/task/save', input);
    return { item: this.task(r.item), side_effects: effects(r.side_effects) };
  }
  async archiveTask(input: { id: string; archived: boolean; expected_row_version?: number }): Promise<MutationResult<Task>> {
    const r = await this.request<WireMutation<Task>>('POST', '/api/task/archive', input);
    return { item: this.task(r.item), side_effects: effects(r.side_effects) };
  }
  async deleteTask(input: { id: string; confirm: true }): Promise<void> {
    await this.request('POST', '/api/task/delete', input);
  }

  async getNote(id: string): Promise<Note | null> {
    try {
      return (await this.request<{ item: Note }>('GET', `/api/note/${encodeURIComponent(id)}`)).item;
    } catch (e) {
      if (e instanceof DataSourceError && e.code === 'not_found') return null;
      throw e;
    }
  }
  async saveNote(input: NoteInput): Promise<MutationResult<Note>> {
    const body = input.id ? { ...input, client_id: undefined } : input;
    const r = await this.request<WireMutation<Note>>('POST', '/api/note/save', body);
    return { item: r.item, side_effects: effects(r.side_effects) };
  }
  async deleteNote(input: { id: string; confirm: true }): Promise<void> {
    await this.request('POST', '/api/note/delete', input);
  }

  // ---- account bulk import (contract §10) ---------------------------------------------------
  async inspectAccountsImport(file: File): Promise<ImportPlan> {
    // Cheap local refusals first; the server repeats every check (it never trusts this).
    try {
      if (file.size > MAX_BYTES) throw new FileRefusal('too_large', 'This file is larger than 5 MB. Split it and import it in parts.');
      sniff(file.name, (await readBytes(file.slice(0, 8192))).subarray(0, 8192));
    } catch (e) {
      if (e instanceof FileRefusal) throw new DataSourceError('invalid_file', e.message, undefined, 422, { reason: e.reason });
      throw e;
    }
    const bytes = await readBytes(file);
    const res = await this.rawRequest('POST', '/api/import/accounts/inspect', bytes, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name.replace(/^.*[\\/]/, '').slice(0, 200)),
    });
    return mapPlan(((await res.json()) as { item: WirePlan }).item);
  }
  async getAccountsImport(importId: string): Promise<ImportPlan> {
    return mapPlan((await this.request<{ item: WirePlan }>('GET', `/api/import/accounts/${encodeURIComponent(importId)}`)).item);
  }
  async applyAccountsImport(input: ImportApplyInput): Promise<ImportResult> {
    return mapResult((await this.request<{ item: ImportResult }>('POST', '/api/import/accounts/apply', input)).item);
  }
  async downloadImportTemplate(format: ImportFormat): Promise<DownloadedFile> {
    return this.download(`/api/import/accounts/template${this.qs({ format })}`, `tam_accounts_import_template.${format}`);
  }
  async downloadSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile> {
    // contract §10.5: the file is in the upload's format; the other extension answers 404
    return this.download(`/api/import/accounts/${encodeURIComponent(importId)}/skipped.${format}`, `tam_accounts_skipped.${format}`);
  }
  async checkSimilarAccount(input: { name: string; bpid: string | null }): Promise<SimilarCheck> {
    const r = await this.request<{ item: { exact: SimilarCheck['exact']; candidates: WireCandidate[] } }>('POST', '/api/client/check-similar', input);
    return { exact: r.item.exact ?? null, candidates: (r.item.candidates ?? []).map(mapCandidate) };
  }
  // ---- BAMS monitoring (contract §11) --------------------------------------------------------
  async getBamsState(q: BamsStateQuery): Promise<BamsState> {
    const r = await this.request<BamsState & { ok: true }>('GET', `/api/bams/state${this.qs({
      view: q.view, account: q.account, object_id: q.object_id, location: q.location, metric: q.metric, status: q.status, q: q.q, sort: q.sort, dir: q.dir,
      include_disabled: q.include_disabled ? 'true' : undefined, spark: q.spark === false ? '0' : undefined,
    })}`);
    return { ...r, rows: r.rows.map(mapBamsRow) };
  }
  async getBamsMetric(id: string): Promise<BamsMetricDetail> {
    const r = (await this.request<{ item: BamsMetricDetail }>('GET', `/api/bams/metric/${encodeURIComponent(id)}`)).item;
    return { ...r, row: mapBamsRow(r.row), rules: r.rules.map(mapBamsRule), alerts: r.alerts.map(mapBamsEvent) };
  }
  async getBamsTrend(id: string, range: TrendRange): Promise<BamsTrend> {
    return (await this.request<{ item: BamsTrend }>('GET', `/api/bams/metric/${encodeURIComponent(id)}/trend${this.qs({ range })}`)).item;
  }
  async getBamsAlerts(q: { status?: AlertListStatus; account?: string; metric_id?: string; limit?: number }): Promise<BamsAlertList> {
    const r = await this.request<BamsAlertList>('GET', `/api/bams/alerts${this.qs({ ...q })}`);
    return { counts: r.counts, next_before: r.next_before ?? null, items: r.items.map((i) => ({ ...i, event: mapBamsEvent(i.event) })) };
  }
  async closeBamsAlert(input: { id: string; note: string | null }): Promise<{ event: BamsAlertEvent; suppressed_until_clear: boolean }> {
    const r = (await this.request<{ item: { event: BamsAlertEvent; suppressed_until_clear: boolean } }>('POST', `/api/bams/alert/${encodeURIComponent(input.id)}/close`, { note: input.note })).item;
    return { event: mapBamsEvent(r.event), suppressed_until_clear: !!r.suppressed_until_clear };
  }
  async setBamsMonitor(run: boolean): Promise<{ monitor: BamsMonitor }> {
    return (await this.request<{ item: { monitor: BamsMonitor } }>('POST', `/api/bams/monitor/${run ? 'start' : 'stop'}`, {})).item;
  }
  async getBamsMonitor(): Promise<{ monitor: BamsMonitor; provider: BamsProvider }> {
    const r = await this.request<{ monitor: BamsMonitor; provider: BamsProvider }>('GET', '/api/bams/monitor');
    return { monitor: r.monitor, provider: r.provider };
  }
  async getBamsSettings(): Promise<BamsSettings> {
    return (await this.request<{ item: BamsSettings }>('GET', '/api/bams/settings')).item;
  }
  async saveBamsSettings(patch: Partial<BamsSettings>): Promise<BamsSettings> {
    return (await this.request<{ item: BamsSettings }>('POST', '/api/bams/settings', patch)).item;
  }
  async saveBamsObject(input: BamsObjectInput): Promise<MutationResult<BamsObjectSaved>> {
    const r = await this.request<WireMutation<{ object: BamsObjectSaved }>>('POST', '/api/bams/object/save', input);
    return { item: { ...r.item.object, enabled: !!r.item.object.enabled }, side_effects: effects(r.side_effects) };
  }
  async saveBamsMetric(input: BamsMetricInput & { object_id?: string }): Promise<void> {
    await this.request('POST', '/api/bams/metric/save', input);
  }
  async getBamsDeletePreview(kind: 'object' | 'metric', id: string): Promise<BamsDeletePreview> {
    const r = (await this.request<{ item: BamsDeletePreview }>('GET', `/api/bams/${kind}/${encodeURIComponent(id)}/delete-preview`)).item;
    return { ...r, blocked: !!r.blocked, blocked_reason: r.blocked_reason ?? null };
  }
  async deleteBamsItem(kind: 'object' | 'metric', input: { id: string; expected_row_version?: number }): Promise<BamsDeleteResult> {
    return (await this.request<{ item: { deleted: BamsDeleteResult } }>('POST', `/api/bams/${kind}/delete`, { ...input, confirm: true })).item.deleted;
  }
  async saveBamsRule(input: BamsRuleInput): Promise<BamsRule> {
    return mapBamsRule((await this.request<{ item: { rule: BamsRule } }>('POST', '/api/bams/rule/save', input)).item.rule);
  }
  async deleteBamsRule(input: { id: string; expected_row_version?: number }): Promise<void> {
    await this.request('POST', '/api/bams/rule/delete', { ...input, confirm: true });
  }
  async getBamsConfigs(): Promise<BamsConfig[]> {
    return (await this.request<{ items: BamsConfig[] }>('GET', '/api/bams/configs')).items.map((c) => ({ ...c, enabled: !!c.enabled, starter: !!c.starter }));
  }
  async previewBamsConfig(input: { config_id: string; metric_ids?: string[] | null }): Promise<BamsConfigPreview> {
    return (await this.request<{ item: BamsConfigPreview }>('POST', '/api/bams/configs/apply', { config_id: input.config_id, metric_ids: input.metric_ids ?? null, preview: true, confirm: false })).item;
  }
  async applyBamsConfig(input: { config_id: string; metric_ids?: string[] | null; plan_hash: string }): Promise<BamsConfigApplied> {
    return (await this.request<{ item: BamsConfigApplied }>('POST', '/api/bams/configs/apply', { ...input, metric_ids: input.metric_ids ?? null, preview: false, confirm: true })).item;
  }
  async getBamsNotifications(limit = 30): Promise<BamsNotifications> {
    const r = await this.request<{ unread_count: number; items: BamsNotifications['items'] }>('GET', `/api/bams/notifications${this.qs({ limit })}`);
    return { unread_count: r.unread_count, items: r.items.map((n) => ({ ...n, unread: !!n.unread })) };
  }
  async markBamsNotificationsRead(input: { through_id: number } | { all: true }): Promise<number> {
    return (await this.request<{ item: { unread_count: number } }>('POST', '/api/bams/notifications/read', input)).item.unread_count;
  }

  // ---- BAMS appliance import (contract §12) -------------------------------------------------
  async inspectBamsImport(file: File): Promise<BamsImportPlan> {
    try {
      if (file.size > MAX_BYTES) throw new FileRefusal('too_large', 'This file is larger than 5 MiB. Split it and import it in parts.');
      sniff(file.name, (await readBytes(file.slice(0, 8192))).subarray(0, 8192));
    } catch (e) {
      if (e instanceof FileRefusal) throw new DataSourceError('invalid_file', e.message, undefined, 422, { reason: e.reason });
      throw e;
    }
    const bytes = await readBytes(file);
    const res = await this.rawRequest('POST', '/api/import/bams/inspect', bytes, {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name.replace(/^.*[\\/]/, '').slice(0, 200)),
    });
    return mapBamsPlan(((await res.json()) as { item: BamsImportPlan }).item);
  }
  async getBamsImport(importId: string): Promise<BamsImportPlan> {
    return mapBamsPlan((await this.request<{ item: BamsImportPlan }>('GET', `/api/import/bams/${encodeURIComponent(importId)}`)).item);
  }
  async applyBamsImport(input: BamsApplyInput): Promise<BamsImportResult> {
    return mapBamsResult((await this.request<{ item: BamsImportResult }>('POST', '/api/import/bams/apply', input)).item);
  }
  async downloadBamsImportTemplate(format: ImportFormat): Promise<DownloadedFile> {
    return this.download(`/api/import/bams/template${this.qs({ format })}`, `tam_bams_import_template.${format}`);
  }
  async downloadBamsSkippedRows(importId: string, format: ImportFormat): Promise<DownloadedFile> {
    return this.download(`/api/import/bams/${encodeURIComponent(importId)}/skipped.${format}`, `tam_bams_skipped.${format}`);
  }

  // ---- Portability (contract section 14) -----------------------------------------------------
  async exportExcel(): Promise<DownloadedFile> { return this.download('/api/export/excel', 'tam_export.xlsx'); }
  async exportDatabase(): Promise<DownloadedFile> { return this.download('/api/export/database', 'tam_backup.db'); }
  private async upload(path: string, file: File, maxBytes: number): Promise<Response> {
    if (file.size > maxBytes) throw new DataSourceError('payload_too_large', `This file is larger than ${Math.round(maxBytes / 1_048_576)} MiB.`, undefined, 413, { reason: 'too_large' });
    return this.rawRequest('POST', path, file, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name.replace(/^.*[\\/]/, '').slice(0, 200)) });
  }
  async inspectRestoreFile(file: File, opts: { session?: string; table?: string } = {}): Promise<RestorePlan> {
    const res = await this.upload(`/api/restore/inspect${this.qs({ session: opts.session, table: opts.table })}`, file, 25 * 1_048_576);
    return mapRestorePlan(((await res.json()) as { item: RestorePlan }).item);
  }
  async getRestorePlan(id: string, q: RestoreIssueQuery = {}): Promise<RestorePlan> {
    return mapRestorePlan((await this.request<{ item: RestorePlan }>('GET', `/api/restore/${encodeURIComponent(id)}${this.qs({ ...q })}`)).item);
  }
  async removeRestoreFile(id: string, fileId: string): Promise<RestorePlan> {
    return mapRestorePlan((await this.request<{ item: RestorePlan }>('POST', `/api/restore/${encodeURIComponent(id)}/remove`, { file_id: fileId })).item);
  }
  async setRestoreTable(id: string, fileId: string, table: string): Promise<RestorePlan> {
    return mapRestorePlan((await this.request<{ item: RestorePlan }>('POST', `/api/restore/${encodeURIComponent(id)}/table`, { file_id: fileId, table })).item);
  }
  async applyRestore(input: { restore_id: string; plan_hash: string }): Promise<RestoreResult> {
    const r = (await this.request<{ item: RestoreResult }>('POST', '/api/restore/apply', { ...input, confirm: true })).item;
    const one = (r as unknown as { file?: string }).file;
    return { ...r, files: [...new Set(r.files ?? (one ? [one] : []))], tables: r.tables ?? [], skipped_preview: r.skipped_preview ?? [], backup: r.backup ?? null };
  }
  async downloadRestoreSkipped(id: string, format: ImportFormat): Promise<DownloadedFile> {
    return this.download(`/api/restore/${encodeURIComponent(id)}/skipped.${format}`, `tam_restore_skipped.${format}`);
  }
  async inspectDatabaseRestore(file: File): Promise<DbRestorePreview> {
    const res = await this.upload('/api/restore/database/inspect', file, 500 * 1_048_576);
    return ((await res.json()) as { item: DbRestorePreview }).item;
  }
  async previewBackupRestore(name: string): Promise<DbRestorePreview> {
    return (await this.request<{ item: DbRestorePreview }>('POST', '/api/restore/database/from-backup', { name })).item;
  }
  async cancelDatabaseRestore(id: string): Promise<void> {
    await this.request('POST', `/api/restore/database/${encodeURIComponent(id)}/cancel`, {});
  }
  async applyDatabaseRestore(input: { restore_id: string; confirm: string }): Promise<DbRestoreResult> {
    return (await this.request<{ item: DbRestoreResult }>('POST', '/api/restore/database/apply', input)).item;
  }

  // ---- Operations (contract section 13) -----------------------------------------------------
  async getOperations(q: OpsQuery): Promise<OpsData> {
    const r = await this.request<OpsData & { ok: true }>('GET', `/api/operations${this.qs({ year: q.year, quarter: q.quarter, q: q.q?.trim(), status: q.status, environment: q.environment, polarity: q.polarity, client_id: q.client_id })}`);
    const { ok: _ok, ...rest } = r;
    void _ok;
    return rest;
  }
  async saveOperationsQuarter(input: OpsQuarterInput): Promise<OpsQuarter> {
    return (await this.request<{ item: OpsQuarter }>('POST', '/api/operations/quarter/save', input)).item;
  }
  async deleteOperationsQuarter(input: { year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): Promise<void> {
    await this.request('POST', '/api/operations/quarter/delete', input);
  }
  async saveOperationsAppliance(input: OpsApplianceInput): Promise<OpsRow> {
    return (await this.request<{ item: OpsRow }>('POST', '/api/operations/appliance/save', input)).item;
  }
  async resetOperationsAppliance(input: { object_id: string; year: number; quarter: OpsQuarterName; confirm: boolean; expected_row_version?: number }): Promise<OpsRow> {
    return (await this.request<{ item: OpsRow }>('POST', '/api/operations/appliance/reset', input)).item;
  }
  async setOperationsVersion(input: { year: number; quarter: OpsQuarterName; object_ids: string[]; target_version: string | null }): Promise<OpsSetVersionResult> {
    return (await this.request<{ item: OpsSetVersionResult }>('POST', '/api/operations/appliance/set-version', input)).item;
  }
}

// ---- BAMS mappers (exported for tests) ----------------------------------------------------------
export function mapBamsRow(r: BamsRow): BamsRow {
  return { ...r, enabled: !!r.enabled, simulated: !!r.simulated, object: { ...r.object, enabled: !!r.object.enabled }, spark: r.spark ?? [] };
}
export function mapBamsRule(r: BamsRule): BamsRule {
  return { ...r, enabled: !!r.enabled, suppress_until_clear: !!r.suppress_until_clear };
}
export function mapBamsEvent(e: BamsAlertEvent): BamsAlertEvent {
  return { ...e, still_breaching: !!e.still_breaching };
}
export function mapBamsPlan(w: BamsImportPlan): BamsImportPlan {
  return {
    ...w,
    warnings: w.warnings ?? [],
    review: (w.review ?? []).map((g) => ({
      ...g,
      candidates: (g.candidates ?? []).map((c) => ({
        ...c, reasons: c.reasons ?? [], differences: c.differences ?? [], fills: c.fills ?? {}, kept: c.kept ?? {}, metrics: c.metrics ?? [],
        metrics_added: c.metrics_added ?? [], metrics_existing: c.metrics_existing ?? [], metrics_conflicts: c.metrics_conflicts ?? [], notes: c.notes ?? [],
      })),
    })),
    rows: w.rows.map((r) => ({ ...r, raw: r.raw ?? null, fills: r.fills ?? {}, kept: r.kept ?? {}, errors: r.errors ?? [], warnings: r.warnings ?? [], notes: r.notes ?? [] })),
  };
}
export function mapRestorePlan(p: RestorePlan): RestorePlan {
  return { ...p, csv_notice: p.csv_notice ?? null, files: (p.files ?? []).map((f) => ({ ...f, missing_columns: f.missing_columns ?? [], ignored_columns: f.ignored_columns ?? [], ...(f.format === 'xlsx' ? { sheets: f.sheets ?? [] } : {}) })), tables: p.tables ?? [], blocking: p.blocking ?? [], warnings: p.warnings ?? [], issues: p.issues ?? [], issues_total: p.issues_total ?? 0 };
}
export function mapBamsResult(r: BamsImportResult): BamsImportResult {
  return { ...r, backup: r.backup ?? null, created: r.created ?? [], updated: r.updated ?? [], skipped: r.skipped ?? [], decisions: r.decisions ?? [], touched_accounts: r.touched_accounts ?? [], breakdown: r.breakdown ?? {}, audit_breakdown: r.audit_breakdown ?? {} };
}

// ---- import mappers (exported for tests). Whitelists fields: a stray numeric score is dropped (D-42). ----
type WireCandidate = Partial<SimilarCandidate> & { ref: CandidateRef; name: string; strength: SimilarCandidate['strength'] };
interface WireRow extends Omit<ImportRow, 'candidates' | 'merged_into' | 'raw' | 'warnings' | 'errors' | 'unchanged'> {
  unchanged?: boolean;
  candidates?: WireCandidate[]; merged_into?: { row: number } | null; raw?: Record<string, string> | null; warnings?: ReasonText[]; errors?: ImportRow['errors'];
}
interface WirePlan extends Omit<ImportPlan, 'rows' | 'file'> {
  rows: WireRow[];
  file: Partial<ImportPlan['file']> & { name: string; size_bytes: number; rows_found: number };
}
const reasons = (l: ReasonText[] | undefined): ReasonText[] => (l ?? []).map((r) => ({ code: String(r.code), text: String(r.text) }));
export function mapCandidate(c: WireCandidate): SimilarCandidate {
  return {
    ref: c.ref, name: c.name, bpid: c.bpid ?? null, products: c.products ?? null, status: c.status ?? null, next_contact: c.next_contact ?? null,
    row_version: c.row_version, strength: c.strength, reasons: reasons(c.reasons), differences: reasons(c.differences),
    fills: c.fills ?? {}, kept: c.kept ?? {}, notes: c.notes ?? [],
  };
}
const values = (v: Partial<ImportValues> | undefined): ImportValues => ({
  name: v?.name ?? null, bpid: v?.bpid ?? null, products: v?.products ?? null, status: v?.status ?? null, next_contact: v?.next_contact ?? null, notes: v?.notes ?? null,
});
export function mapPlan(w: WirePlan): ImportPlan {
  const ext = /\.(xlsx|csv)$/i.exec(w.file.name)?.[1]?.toLowerCase() as ImportFormat | undefined;
  return {
    import_id: w.import_id, plan_hash: w.plan_hash, expires_at: w.expires_at,
    file: {
      name: w.file.name, size_bytes: w.file.size_bytes, rows_found: w.file.rows_found, format: w.file.format ?? ext ?? 'xlsx',
      sheet: w.file.sheet ?? null, encoding: w.file.encoding ?? null, delimiter: w.file.delimiter ?? null, notes: w.file.notes ?? [],
    },
    limits: w.limits, counts: w.counts, warnings: reasons(w.warnings),
    rows: w.rows.map((r) => ({
      row: r.row, state: r.state, values: values(r.values), raw: r.raw ?? null, errors: r.errors ?? [], warnings: reasons(r.warnings),
      match: r.match ? { ...r.match, notes: r.match.notes ?? [], reasons: reasons(r.match.reasons), fills: r.match.fills ?? {}, kept: r.match.kept ?? {} } : null,
      merged_into: r.merged_into ?? null, unchanged: r.unchanged, candidates: (r.candidates ?? []).map(mapCandidate),
    })),
  };
}
export function mapResult(r: ImportResult): ImportResult {
  return { ...r, backup: r.backup ?? null, created: r.created ?? [], updated: r.updated ?? [], skipped: r.skipped ?? [], breakdown: r.breakdown ?? {} };
}

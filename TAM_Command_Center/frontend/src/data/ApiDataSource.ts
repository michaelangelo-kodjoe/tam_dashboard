// ApiDataSource: HTTP adapter for the FastAPI backend (Phase 4.1 swap target).
// Aligned with docs/04_API_CONTRACT.md (frozen for run 1). It is a thin mapper: wire shapes
// (nested `counts`, `kind`-tagged activity entries, object side effects, `{settings: ...}`
// bodies) are converted to the domain types in src/types.ts so no component changes when the
// adapter is swapped. This module (with MockDataSource's JSON loader) is the only place that
// calls fetch. NOT yet exercised against the live backend (Phase 4.1); contract-shaped
// payloads are covered by ApiDataSource.test.ts.
import type {
  Account, AccountInput, AccountSummary, ActivityEntry, ActivityPage, AppState, BackupInfo, BamsObject, Contact,
  ContactInput, Freshness, Infrastructure, InfrastructureSummary, MutationResult, Note, NoteInput, QueueItem, RecentChange,
  Runtime, ServerUpgrade, Settings, Task, TaskInput, TaskQuery, TodayData,
} from '../types';
import { DataSourceError, type ActivityQuery, type DataSource, type ErrorCode } from './DataSource';

type Json = Record<string, unknown>;

// ---- wire shapes (docs/04_API_CONTRACT.md) ----------------------------------------------
interface WireAccount extends Omit<Account, never> {
  counts: { open_tasks: number; overdue: number; waiting: number; active_alerts: number; next_upgrade: string | null; upcoming_upgrades: number; servers: number };
}
interface WireInfra {
  client_id?: string;
  servers: number;
  active_alerts: number;
  environment_summary: Record<string, number | string[]>;
  bams_objects: (Omit<BamsObject, 'active_alerts'> & { alerts?: { status: string }[] })[];
  server_upgrades: ServerUpgrade[];
}
type WireSideEffect = { type: string; name?: string; contact_id?: string };
interface WireMutation<T> { ok: true; item: T; side_effects?: WireSideEffect[] }
type WireActivity =
  | { kind: 'note'; entry_key: string; ts: string; id: string; note_type: Note['note_type']; subject: string | null; body: string | null; action_items: string | null; source: string; row_version: number; updated_at: string }
  | { kind: 'system'; entry_key: string; ts: string; event_type: string; object_type: string; object_id: string; label: string | null; severity: string | null; source: string; sentence: string };

// ---- mappers (exported for tests) -------------------------------------------------------
export function mapAccount(a: WireAccount): AccountSummary {
  const { counts, ...rest } = a;
  return { ...rest, ...counts };
}

export function mapInfraSummary(w: WireInfra, today: string): InfrastructureSummary {
  const env = w.environment_summary ?? {};
  const parts = Object.entries(env)
    .filter(([k, v]) => k !== 'regions' && k !== 'unknown' && typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k} ${v}`);
  if (typeof env.unknown === 'number' && env.unknown > 0) parts.push(`Unknown ${env.unknown}`);
  const next = (w.server_upgrades ?? [])
    .filter((u) => u.scheduled_date && u.scheduled_date >= today && u.status !== 'Completed' && u.status !== 'Deferred')
    .sort((a, b) => (a.scheduled_date! < b.scheduled_date! ? -1 : 1))[0];
  return {
    servers: w.servers,
    active_alerts: w.active_alerts,
    next_upgrade: next ? { date: next.scheduled_date!, server: next.server_name } : null,
    env_summary: parts.join(' · '),
    regions: Array.isArray(env.regions) ? (env.regions as string[]) : [],
  };
}

export function mapInfra(w: WireInfra & { client_id: string }, today: string): Infrastructure {
  return {
    client_id: w.client_id,
    bams_objects: w.bams_objects.map((o) => ({
      id: o.id, client_id: o.client_id, name: o.name, region: o.region, location: o.location, environment: o.environment,
      enabled: !!o.enabled, worst_status: o.worst_status as Freshness, metric_count: o.metric_count, active_alerts: o.alerts?.length ?? 0,
    })),
    upgrades: w.server_upgrades,
    summary: mapInfraSummary(w, today),
  };
}

export function mapActivity(e: WireActivity, clientId: string): ActivityEntry {
  if (e.kind === 'note') {
    return {
      entry_kind: 'note', entry_key: e.entry_key, ts: e.ts,
      note: {
        id: e.id, client_id: clientId, note_type: e.note_type, timestamp: e.ts, subject: e.subject, body: e.body, action_items: e.action_items,
        source: e.source, created_at: e.ts, updated_at: e.updated_at, row_version: e.row_version,
      },
    };
  }
  const label = e.label ?? '';
  const server = e.object_type === 'server_upgrade' ? label : e.event_type.startsWith('bams_alert.') ? label.split(' · ')[0] : null;
  return {
    entry_kind: 'system', entry_key: e.entry_key, ts: e.ts, object_type: e.object_type, object_id: e.object_id,
    sentence: e.sentence, source: e.source, severity: e.severity, server_name: server || null,
  };
}

function effects(list: WireSideEffect[] | undefined): string[] {
  return (list ?? []).map((s) => s.type);
}

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;
  private today = '';
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
      const err = (json?.error ?? {}) as { code?: ErrorCode; message?: string; fields?: Record<string, string> };
      throw new DataSourceError(err.code ?? 'internal', err.message ?? `Request failed (${res.status}).`, err.fields, res.status);
    }
    return json as T;
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
    this.today = s.today;
    const infra: Record<string, InfrastructureSummary> = {};
    for (const [id, w] of Object.entries(s.infrastructure)) infra[id] = mapInfraSummary(w, s.today);
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
    const t = await this.request<{ today: string; queue: QueueItem[]; upcoming: QueueItem[]; recent_changes: RecentChange[]; account_load: TodayData['account_load'] }>('GET', '/api/today');
    return { today: t.today, queue: t.queue, upcoming: t.upcoming, recent_changes: t.recent_changes, account_load: t.account_load, generated_at: new Date().toISOString() };
  }

  async getActivity(clientId: string, q: ActivityQuery): Promise<ActivityPage> {
    const r = await this.request<{ items: WireActivity[]; next_cursor: string | null }>(
      'GET',
      `/api/client/${encodeURIComponent(clientId)}/activity${this.qs({ filter: q.filter, q: q.q, before: q.cursor, limit: q.limit })}`,
    );
    return { items: r.items.map((e) => mapActivity(e, clientId)), next_cursor: r.next_cursor };
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
    return mapInfra(w, this.today || new Date().toISOString().slice(0, 10));
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

  async saveNote(input: NoteInput): Promise<MutationResult<Note>> {
    const body = input.id ? { ...input, client_id: undefined } : input;
    const r = await this.request<WireMutation<Note>>('POST', '/api/note/save', body);
    return { item: r.item, side_effects: effects(r.side_effects) };
  }
  async deleteNote(input: { id: string; confirm: true }): Promise<void> {
    await this.request('POST', '/api/note/delete', input);
  }
}

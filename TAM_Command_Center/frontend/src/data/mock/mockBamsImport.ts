// Mock engine for the BAMS appliance and metrics import (docs/04_API_CONTRACT.md §12, PM D-63..D-72).
// One file row = one metric of one appliance. Nothing is written before apply; apply never overwrites
// and never deletes; tickers are never changed. The matcher reuses the accounts matcher (dupes.ts)
// over the account's appliance names and keeps a candidate only when it carries the same numbers.
import type {
  BamsApplyInput, BamsCandidate, BamsCandidateRef, BamsImportPlan, BamsImportResult, BamsImportRow, BamsImportRowIssue, BamsImportValues, BamsKept, BamsReviewGroup, BamsRowState,
} from '../../bamsTypes';
import type { ImportFormat } from '../../types';
import { DataSourceError } from '../DataSource';
import { FileRefusal, MAX_ROWS, type Grid } from '../importFile';
import { compare, exactKey, orderHits, storedName } from './dupes';
import type { Row } from './rebase';
import type { MockBams } from './mockBams';

export const BAMS_HEADERS = ['Account', 'BPID', 'Appliance', 'Metric', 'Ticker', 'Region', 'Location', 'Environment', 'Enabled', 'Stale after (s)'] as const;
type Header = (typeof BAMS_HEADERS)[number];
const KEY: Record<Header, keyof BamsImportValues> = {
  Account: 'account', BPID: 'bpid', Appliance: 'appliance', Metric: 'metric', Ticker: 'ticker', Region: 'region', Location: 'location', Environment: 'environment', Enabled: 'enabled', 'Stale after (s)': 'stale_after_seconds',
};
const lc = (s: string) => s.trim().toLowerCase();
const colLetter = (i: number) => String.fromCharCode(65 + i);
const clean = (s: string) => storedName(s);

export interface ParsedBams { row: number; values: BamsImportValues; raw: Record<string, string>; errors: BamsImportRowIssue[]; warnings: { code: string; text: string }[] }
export interface BamsParsed { rows: ParsedBams[]; warnings: { code: string; text: string }[] }

export function parseBamsGrid(grid: Grid): BamsParsed {
  const head = grid[0] ?? [];
  const map = new Map<number, Header>();
  const warnings: { code: string; text: string }[] = [];
  const found: string[] = [];
  head.forEach((c, i) => {
    const name = c.v.trim();
    if (!name) return;
    found.push(name);
    const h = BAMS_HEADERS.find((x) => lc(x) === lc(name));
    if (!h) { warnings.push({ code: 'unknown_column', text: `Column ${colLetter(i)} "${name}" is ignored.` }); return; }
    if ([...map.values()].includes(h)) throw new FileRefusal('header_duplicate', `The column "${h}" appears twice in the header row. Keep one.`);
    map.set(i, h);
  });
  const have = new Set(map.values());
  const missing = [(['Appliance', 'Metric', 'Ticker'] as Header[]).filter((h) => !have.has(h)), !have.has('Account') && !have.has('BPID') ? ['Account or BPID'] : []].flat();
  if (missing.length) throw new FileRefusal('header_missing', `Missing required column: ${missing.join(', ')}`, { missing, found });
  const rows: ParsedBams[] = [];
  for (let r = 1; r < Math.min(grid.length, 10_001); r++) {
    const cells = grid[r] ?? [];
    const raw: Record<string, string> = {};
    const formulas: string[] = [];
    for (const [i, h] of map) {
      const c = cells[i];
      raw[h] = c?.formula ? '' : (c?.v ?? '');
      if (c?.formula) formulas.push(h);
    }
    if (!formulas.length && BAMS_HEADERS.every((h) => (raw[h] ?? '').trim() === '')) continue;
    rows.push(validateRow(r + 1, raw, formulas));
  }
  if (rows.length === 0) throw new FileRefusal('no_rows', 'No appliance rows were found in this file.');
  if (rows.length > MAX_ROWS) throw new FileRefusal('too_many_rows', `Too many rows: ${rows.length} data rows, limit is ${MAX_ROWS}`, { found: rows.length, limit: MAX_ROWS });
  return { rows, warnings };
}

function validateRow(row: number, raw: Record<string, string>, formulas: string[]): ParsedBams {
  const errors: BamsImportRowIssue[] = [];
  const err = (field: string, code: string, text: string) => errors.push({ field, code, text: `Row ${row}: ${text} This row will be skipped.` });
  const s = (h: Header) => clean(raw[h] ?? '') || null;
  const v: BamsImportValues = {
    account: s('Account'), bpid: s('BPID'), appliance: s('Appliance'), metric: s('Metric'), ticker: s('Ticker'), region: s('Region'), location: s('Location'),
    environment: (s('Environment') ?? '').toUpperCase() || null, enabled: true, stale_after_seconds: 120,
  };
  for (const f of formulas) err(KEY[f as Header], 'formula_not_allowed', `${f} holds a formula, which is not allowed.`);
  if (!v.account && !v.bpid) err('account', 'account_required', 'Account or BPID is required.');
  if (!v.appliance) err('appliance', 'appliance_required', 'Appliance is required.');
  else if (v.appliance.length > 200) err('appliance', 'appliance_too_long', 'Appliance is longer than 200 characters.');
  if (!v.metric) err('metric', 'metric_required', 'Metric is required.');
  else if (v.metric.length > 200) err('metric', 'metric_too_long', 'Metric is longer than 200 characters.');
  if (!v.ticker) err('ticker', 'ticker_required', 'Ticker is required.');
  else if (v.ticker.length > 200) err('ticker', 'ticker_too_long', 'Ticker is longer than 200 characters.');
  if ((v.region ?? '').length > 100) err('region', 'region_too_long', 'Region is longer than 100 characters.');
  if ((v.location ?? '').length > 200) err('location', 'location_too_long', 'Location is longer than 200 characters.');
  if (v.environment && v.environment !== 'PROD' && v.environment !== 'DEV') err('environment', 'environment_invalid', `Environment must be PROD or DEV (found ${v.environment}).`);
  const en = lc(raw.Enabled ?? '');
  if (en) {
    if (['yes', 'y', 'true', '1'].includes(en)) v.enabled = true;
    else if (['no', 'n', 'false', '0'].includes(en)) v.enabled = false;
    else err('enabled', 'enabled_invalid', 'Enabled must be Yes or No.');
  }
  const st = (raw['Stale after (s)'] ?? '').trim();
  if (st) {
    if (/^\d+$/.test(st) && Number(st) > 0) v.stale_after_seconds = Number(st);
    else err('stale_after_seconds', 'stale_after_invalid', 'Stale after (s) must be a whole number above 0.');
  }
  return { row, values: v, raw, errors, warnings: [] };
}

interface Session { parsed: BamsParsed; name: string; size: number; format: 'xlsx' | 'csv'; sheet: string | null; encoding: string | null; delimiter: string | null; notes: string[]; applied: BamsImportResult | null }

const digitsOf = (s: string) => (s.match(/\d+/g) ?? []).map((d) => String(Number(d))).join(',');
const wordsOf = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean).join(' ');

export class MockBamsImport {
  private sessions = new Map<string, Session>();
  private lastId = 0;
  constructor(private bams: MockBams, private ctx: { t: Record<string, Row[]>; now: () => string; uuid: () => string; backup: () => { name: string; size_bytes: number } }) {}

  create(parsed: BamsParsed, meta: { name: string; size: number; format: 'xlsx' | 'csv'; sheet: string | null; encoding: string | null; delimiter: string | null; notes: string[] }): BamsImportPlan {
    if ([...this.sessions.values()].filter((s) => !s.applied).length >= 3) for (const [k, s] of this.sessions) { if (!s.applied) { this.sessions.delete(k); break; } }
    const id = `${(++this.lastId).toString(16).padStart(4, '0')}${this.ctx.uuid().replace(/-/g, '')}`.slice(0, 32);
    this.sessions.set(id, { parsed, ...meta, applied: null });
    return this.plan(id);
  }
  session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new DataSourceError('import_expired', 'This import timed out. Choose the file again.', undefined, 410);
    return s;
  }

  private resolveAccount(v: BamsImportValues): { client?: Row; error?: BamsImportRowIssue } {
    const t = this.ctx.t;
    const byBpid = v.bpid ? t.clients.filter((c) => (c.bpid ?? '').trim() === v.bpid) : [];
    const byName = v.account ? t.clients.filter((c) => exactKey(c.name) === exactKey(v.account!)) : [];
    if (v.bpid && byBpid.length === 1) {
      if (v.account && byName.length === 1 && byName[0].id !== byBpid[0].id) return { error: { field: 'account', code: 'account_mismatch', text: 'BPID and account name belong to different accounts.' } };
      return { client: byBpid[0] };
    }
    if (byName.length === 1) return { client: byName[0] };
    if (byName.length > 1) return { error: { field: 'account', code: 'account_ambiguous', text: `Account "${v.account}" matches more than one account.` } };
    return { error: { field: 'account', code: 'account_not_found', text: `Account "${v.account ?? v.bpid}" not found. Accounts are never created by this import.` } };
  }

  plan(id: string): BamsImportPlan {
    const s = this.session(id);
    const t = this.ctx.t;
    const rows: BamsImportRow[] = s.parsed.rows.map((p) => ({
      row: p.row, state: 'new' as BamsRowState, values: p.values, raw: null, target: null, group: null, review_key: null, fills: {}, kept: {},
      errors: [...p.errors], warnings: [...p.warnings], notes: [],
    }));
    const clientOf = new Map<number, Row>();
    for (const r of rows) {
      if (r.errors.length) { r.raw = s.parsed.rows.find((p) => p.row === r.row)!.raw; continue; }
      const a = this.resolveAccount(r.values);
      if (a.error) r.errors.push({ ...a.error, text: `Row ${r.row}: ${a.error.text} This row will be skipped.` });
      else clientOf.set(r.row, a.client!);
    }
    // ticker rules
    const tickerRows = new Map<string, BamsImportRow[]>();
    const seenTriple = new Map<string, number>();
    for (const r of rows) {
      if (r.errors.length || !clientOf.has(r.row)) continue;
      const c = clientOf.get(r.row)!;
      const triple = `${c.id}|${lc(r.values.appliance!)}|${lc(r.values.metric!)}|${lc(r.values.ticker!)}`;
      if (seenTriple.has(triple)) { r.errors.push({ field: 'ticker', code: 'repeats_row', text: `Row ${r.row}: repeats row ${seenTriple.get(triple)} (same appliance and metric). This row will be skipped.` }); continue; }
      seenTriple.set(triple, r.row);
      const k = lc(r.values.ticker!);
      tickerRows.set(k, [...(tickerRows.get(k) ?? []), r]);
    }
    for (const list of tickerRows.values()) {
      const kinds = new Set(list.map((r) => `${clientOf.get(r.row)!.id}|${lc(r.values.appliance!)}|${lc(r.values.metric!)}`));
      if (kinds.size > 1) for (const r of list) r.errors.push({ field: 'ticker', code: 'ticker_repeated_in_file', text: `Row ${r.row}: Ticker ${r.values.ticker} is used by more than one metric in this file. This row will be skipped.` });
    }
    const existingApp = (r: BamsImportRow) => t.bams_objects.find((o) => o.client_id === clientOf.get(r.row)!.id && lc(o.name) === lc(r.values.appliance!));
    for (const r of rows) {
      if (r.errors.length || !clientOf.has(r.row)) continue;
      const app = existingApp(r);
      const mine = app ? t.bams_metrics.find((m) => m.object_id === app.id && lc(m.metric_name) === lc(r.values.metric!)) : undefined;
      const owner = t.bams_metrics.find((m) => lc(m.ticker) === lc(r.values.ticker!));
      if (mine && lc(mine.ticker) !== lc(r.values.ticker!)) r.errors.push({ field: 'ticker', code: 'ticker_differs', text: `Row ${r.row}: ${r.values.metric} on ${app!.name} already has ticker ${mine.ticker}. Tickers are never changed by import; this row will be skipped.` });
      else if (owner && owner.id !== mine?.id) {
        const oo = t.bams_objects.find((o) => o.id === owner.object_id);
        const cl = t.clients.find((c) => c.id === oo?.client_id);
        r.errors.push({ field: 'ticker', code: 'ticker_conflict', text: `Row ${r.row}: Ticker ${r.values.ticker} is already used by ${owner.metric_name} on ${oo?.name} (${cl?.name}). Tickers are never changed by import; this row will be skipped.` });
      }
    }
    for (const r of rows) if (r.errors.length) { r.state = 'invalid'; r.raw = r.raw ?? s.parsed.rows.find((p) => p.row === r.row)!.raw; }
    // groups
    const groups = new Map<string, { key: string; clientId: string; rows: BamsImportRow[] }>();
    for (const r of rows) {
      if (r.state === 'invalid') continue;
      const c = clientOf.get(r.row)!;
      const gk = `${c.id}|${lc(r.values.appliance!)}`;
      const g: { key: string; clientId: string; rows: BamsImportRow[] } = groups.get(gk) ?? { key: `g${r.row}`, clientId: c.id as string, rows: [] };
      g.rows.push(r);
      groups.set(gk, g);
      r.group = g.key;
    }
    const review: BamsReviewGroup[] = [];
    const groupList = [...groups.values()];
    for (const g of groupList) {
      const first = g.rows[0];
      const c = clientOf.get(first.row)!;
      const app = existingApp(first);
      const client = c;
      const fileAp = { region: first.values.region, location: first.values.location, environment: first.values.environment };
      first.target = null;
      if (app) {
        const fills: Record<string, string> = {};
        const kept: Record<string, BamsKept> = {};
        for (const f of ['region', 'location', 'environment'] as const) {
          const ex = app[f] as string | null; const fv = fileAp[f];
          if (!ex && fv) fills[f] = fv;
          else if (ex && fv) kept[f] = { existing: ex, file: fv, differs: lc(ex) !== lc(fv) };
        }
        let firstDone = false;
        for (const r of g.rows) {
          const mine = t.bams_metrics.find((m) => m.object_id === app.id && lc(m.metric_name) === lc(r.values.metric!));
          const same = !!mine;
          const hasFill = !firstDone && Object.keys(fills).length > 0;
          r.state = same ? (hasFill ? 'update' : 'unchanged') : 'new';
          if (!firstDone) { r.fills = fills; r.kept = kept; firstDone = true; }
          r.notes = same ? (hasFill ? [`Same ticker. Fills ${Object.keys(fills).map((k) => k[0].toUpperCase() + k.slice(1)).join(', ')} only.`] : ['Already exists with this ticker.']) : ['New metric on this appliance.'];
          r.target = { client_id: client.id, client_name: client.name, appliance: { id: app.id, name: app.name, is_new: false }, metric: { id: mine?.id ?? null, is_new: !mine } };
        }
        continue;
      }
      // new appliance: similar within the account (existing + earlier groups)
      const cands: BamsCandidate[] = [];
      const pool: { ref: BamsCandidateRef; name: string; id: string; app?: Row; group?: typeof g }[] = [
        ...t.bams_objects.filter((o) => o.client_id === g.clientId).map((o) => ({ ref: { type: 'appliance' as const, id: o.id as string }, name: o.name as string, id: o.id as string, app: o })),
        ...groupList.filter((o) => o.clientId === g.clientId && o !== g && Number(o.key.slice(1)) < Number(g.key.slice(1)) && !existingApp(o.rows[0])).map((o) => ({ ref: { type: 'group' as const, key: o.key }, name: o.rows[0].values.appliance!, id: o.key, group: o })),
      ];
      for (const p of pool) {
        if (exactKey(p.name) === exactKey(first.values.appliance!)) continue;
        const hit = compare({ name: first.values.appliance!, bpid: null }, { name: p.name, bpid: null });
        if (!hit) continue;
        if (digitsOf(first.values.appliance!) !== digitsOf(p.name)) continue;
        if (hit.reasons.length === 1 && hit.reasons[0].code === 'shared_key_words' && wordsOf(first.values.appliance!) !== wordsOf(p.name)) continue;
        const existingMetrics = p.app ? t.bams_metrics.filter((m) => m.object_id === p.app!.id) : [];
        const theirMetricNames = p.app ? existingMetrics.map((m) => m.metric_name as string) : p.group!.rows.map((r) => r.values.metric!);
        const mine = g.rows.map((r) => r.values.metric!);
        const fills: Record<string, string> = {};
        const kept: Record<string, BamsKept> = {};
        const src = p.app ?? { region: p.group!.rows[0].values.region, location: p.group!.rows[0].values.location, environment: p.group!.rows[0].values.environment };
        for (const f of ['region', 'location', 'environment'] as const) {
          const ex = (src as Row)[f] as string | null; const fv = fileAp[f];
          if (!ex && fv) fills[f] = fv; else if (ex && fv) kept[f] = { existing: ex, file: fv, differs: lc(ex) !== lc(fv) };
        }
        cands.push({
          ref: p.ref, name: p.name, region: (src as Row).region ?? null, location: (src as Row).location ?? null, environment: (src as Row).environment ?? null, enabled: p.app ? !!p.app.enabled : true,
          row_version: p.app?.row_version, metric_count: theirMetricNames.length, metrics: theirMetricNames, strength: hit.strength, reasons: hit.reasons, differences: hit.differences,
          fills, kept, metrics_added: mine.filter((m) => !theirMetricNames.some((x) => lc(x) === lc(m))), metrics_existing: mine.filter((m) => theirMetricNames.some((x) => lc(x) === lc(m))),
          metrics_conflicts: [], notes: [],
        });
      }
      const ordered = orderHits(cands.map((c) => ({ ...c, id: c.ref.type === 'appliance' ? c.ref.id : c.ref.key })), 5).map(({ id: _id, ...c }) => { void _id; return c as BamsCandidate; });
      if (ordered.length) {
        for (const r of g.rows) { r.state = 'needs_review'; r.review_key = g.key; r.notes = ['Waiting for your decision in step 3.']; }
        review.push({ key: g.key, client_id: client.id, client_name: client.name, rows: g.rows.map((r) => r.row), file: { appliance: first.values.appliance!, ...fileAp, metrics: g.rows.map((r) => r.values.metric!) } as BamsReviewGroup['file'], strength: ordered[0].strength, candidates: ordered });
      } else {
        for (const r of g.rows) {
          r.state = 'new'; r.notes = ['New appliance and metric.'];
          r.target = { client_id: client.id, client_name: client.name, appliance: { id: null, name: first.values.appliance!, is_new: true }, metric: { id: null, is_new: true } };
        }
      }
    }
    const count = (st: BamsRowState) => rows.filter((r) => r.state === st).length;
    const appStates = groupList.map((g) => g.rows[0].state === 'needs_review' ? 'needs_review' : g.rows[0].target?.appliance.is_new ? 'new' : g.rows.some((r) => r.state === 'update') ? 'updated' : 'unchanged');
    const plan: BamsImportPlan = {
      import_id: id, plan_hash: '', expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      file: { name: s.name, size_bytes: s.size, format: s.format, sheet: s.sheet, rows_found: rows.length, encoding: s.encoding, delimiter: s.delimiter, notes: s.notes },
      limits: { max_rows: MAX_ROWS, max_candidates: 5, max_bytes: 5 * 1024 * 1024 },
      counts: { rows: rows.length, valid: rows.length - count('invalid'), new: count('new'), updates: count('update'), unchanged: count('unchanged'), needs_review: count('needs_review'), invalid: count('invalid') },
      appliances: { new: appStates.filter((x) => x === 'new').length, updated: appStates.filter((x) => x === 'updated').length, unchanged: appStates.filter((x) => x === 'unchanged').length, needs_review: review.length },
      metrics: { new: count('new'), updated: count('update'), unchanged: count('unchanged') },
      warnings: s.parsed.warnings, review, rows,
      operations_note: opsNote(rows),
    };
    plan.plan_hash = hashBams(plan);
    return plan;
  }

  apply(input: BamsApplyInput): BamsImportResult {
    if (input.confirm !== true) throw new DataSourceError('confirmation_required', 'Confirmation required.', undefined, 409);
    const s = this.session(input.import_id);
    if (s.applied) throw new DataSourceError('already_applied', 'This import was already applied.', undefined, 409, { result: s.applied });
    const plan = this.plan(input.import_id);
    if (plan.plan_hash !== input.plan_hash) throw new DataSourceError('preview_stale', 'Appliances changed since the preview was made.', undefined, 409, { changed: [] });
    const dec = new Map<string, (typeof input.decisions)[number]>();
    for (const d of input.decisions) {
      if (dec.has(d.key)) throw new DataSourceError('validation_error', 'Duplicate decision.', { decisions: d.key }, 422);
      const g = plan.review.find((x) => x.key === d.key);
      if (!g) throw new DataSourceError('validation_error', 'Not a flagged appliance.', { decisions: d.key }, 422);
      if (d.choice === 'same' && !d.target) throw new DataSourceError('validation_error', 'Same needs a target.', { decisions: d.key }, 422);
      if (d.choice !== 'same' && d.target) throw new DataSourceError('validation_error', 'Only Same takes a target.', { decisions: d.key }, 422);
      if (d.target && !g.candidates.some((c) => JSON.stringify(c.ref) === JSON.stringify(d.target))) throw new DataSourceError('validation_error', 'Target is not a candidate.', { decisions: d.key }, 422);
      dec.set(d.key, d);
    }
    const open = plan.review.filter((g) => !dec.has(g.key));
    if (open.length) throw new DataSourceError('unresolved_duplicates', `${open.length} similar ${open.length === 1 ? 'appliance needs' : 'appliances need'} a decision.`, undefined, 409, { keys: open.map((g) => g.key), rows: open.flatMap((g) => g.rows) });
    const t = this.ctx.t;
    const created: BamsImportResult['created'] = []; const updated: BamsImportResult['updated'] = [];
    const labels: BamsImportResult['decisions'] = [];
    let skippedUser = 0; let filled = 0; let mCreated = 0; let auditN = 0; let aCreated = 0; let aUpdated = 0;
    const appOf = new Map<string, string>();
    const touched = new Map<string, string>();
    const changes = plan.rows.some((r) => ['new', 'update'].includes(r.state)) || plan.review.some((g) => dec.get(g.key)!.choice !== 'skip');
    const backup = changes ? this.ctx.backup() : null;
    const ts = this.ctx.now();
    const byGroup = new Map<string, BamsImportRow[]>();
    for (const r of plan.rows) if (r.group && r.state !== 'invalid') byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
    const ordered = [...byGroup.entries()].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
    for (const [key, rs] of ordered) {
      const first = rs[0];
      const d = dec.get(key);
      const clientId = first.target?.client_id ?? plan.review.find((g) => g.key === key)!.client_id;
      const clientName = t.clients.find((c) => c.id === clientId)?.name ?? '';
      if (d?.choice === 'skip') { skippedUser += rs.length; labels.push({ key, choice: 'skip', label: `${first.values.appliance} skipped` }); continue; }
      let appId: string | null = first.target && !first.target.appliance.is_new ? first.target.appliance.id : null;
      if (d?.choice === 'same') {
        const tg = d.target!;
        appId = tg.type === 'appliance' ? tg.id : appOf.get(tg.key) ?? null;
        const tname = plan.review.find((g) => g.key === key)!.candidates.find((c) => JSON.stringify(c.ref) === JSON.stringify(tg))!.name;
        labels.push({ key, choice: 'same', label: `${first.values.appliance} merged into ${tname}` });
      } else if (d?.choice === 'different') labels.push({ key, choice: 'different', label: `${first.values.appliance} created as new` });
      const toAdd = rs.filter((r) => !(appId && t.bams_metrics.some((m) => m.object_id === appId && lc(m.metric_name) === lc(r.values.metric!))));
      if (!appId) {
        const saved = this.bams.saveObject({
          client_id: clientId, name: first.values.appliance!, region: first.values.region, location: first.values.location, environment: first.values.environment as 'PROD' | 'DEV' | null, enabled: true,
          metrics: rs.map((r) => ({ metric_name: r.values.metric!, ticker: r.values.ticker!, enabled: r.values.enabled, stale_after_seconds: r.values.stale_after_seconds })),
        });
        appId = saved.id; appOf.set(key, appId); aCreated++; mCreated += rs.length; auditN += 1 + rs.length;
        created.push({ id: appId, name: saved.name, client_id: clientId, client_name: clientName, rows: rs.map((r) => r.row), metrics: rs.map((r) => r.values.metric!) });
        touched.set(clientId, clientName);
        continue;
      }
      appOf.set(key, appId);
      const app = t.bams_objects.find((o) => o.id === appId)!;
      const fills: string[] = [];
      for (const f of ['region', 'location', 'environment'] as const) if (!app[f] && first.values[f]) { app[f] = first.values[f]; fills.push(f); }
      for (const r of toAdd) {
        t.bams_metrics.push({
          id: this.ctx.uuid(), object_id: appId, metric_name: r.values.metric, ticker: r.values.ticker, current_value: null, last_source_update: null, last_received: null,
          high_30: null, high_30_date: null, high_60: null, high_60_date: null, high_90: null, high_90_date: null, enabled: r.values.enabled ? 1 : 0, stale_suppressed: 0,
          stale_after_seconds: r.values.stale_after_seconds, created_at: ts, updated_at: ts, row_version: 1,
        });
      }
      if (fills.length || toAdd.length) {
        if (fills.length) { app.row_version += 1; app.updated_at = ts; }
        aUpdated++; mCreated += toAdd.length; filled += fills.length; auditN += 1 + toAdd.length;
        updated.push({ id: appId, name: app.name, client_id: clientId, client_name: clientName, rows: rs.map((r) => r.row), filled: fills, metrics_added: toAdd.map((r) => r.values.metric!) });
        touched.set(clientId, clientName);
      }
    }
    const invalidRows = plan.rows.filter((r) => r.state === 'invalid');
    const unchangedApps = plan.appliances.unchanged;
    const result: BamsImportResult = {
      import_id: input.import_id, applied_at: ts, file: { name: s.name, rows_found: plan.file.rows_found, format: s.format },
      counts: { appliances_created: aCreated, appliances_updated: aUpdated, appliances_unchanged: unchangedApps, metrics_created: mCreated, metrics_updated: plan.metrics.updated, metrics_unchanged: plan.metrics.unchanged, skipped: invalidRows.length + skippedUser, invalid: invalidRows.length, overwritten: 0 },
      breakdown: { created_new: aCreated, created_marked_different: [...dec.values()].filter((d) => d.choice === 'different').length, merged_exact: updated.length, merged_marked_same: [...dec.values()].filter((d) => d.choice === 'same').length, skipped_invalid: invalidRows.length, skipped_by_user: skippedUser },
      decisions: labels, fields_filled: filled, audit_events: auditN, audit_breakdown: { appliance: aCreated + aUpdated, metric: mCreated },
      backup: backup ? { name: backup.name, reason: 'pre-import', size_bytes: backup.size_bytes } : null,
      touched_accounts: [...touched].map(([id, name]) => ({ id, name })), created, updated,
      operations_note: plan.operations_note ?? null,
      skipped: [
        ...invalidRows.map((r) => ({ row: r.row, name: `${r.values.appliance ?? ''} / ${r.values.metric ?? ''}`, kind: 'invalid', reason: r.errors[0]?.text.replace(/^Row \d+: /, '').replace(/ This row will be skipped\.$/, '') ?? '' })),
        ...plan.rows.filter((r) => r.group && dec.get(r.group)?.choice === 'skip').map((r) => ({ row: r.row, name: `${r.values.appliance} / ${r.values.metric}`, kind: 'user', reason: 'Skipped by you' })),
      ],
      skipped_url: invalidRows.length + skippedUser ? `/api/import/bams/${input.import_id}/skipped.xlsx` : null,
    };
    s.applied = result;
    return result;
  }

  /** Rows for the skipped-rows download (the ten import headers, then Source row, Reason, Possible duplicate of). */
  skippedRows(importId: string, _format: ImportFormat): string[][] {
    const s = this.session(importId);
    if (!s.applied) throw new DataSourceError('conflict', 'Nothing was applied yet.', undefined, 409);
    const plan = s.parsed.rows;
    const head = [...BAMS_HEADERS, 'Source row', 'Reason', 'Possible duplicate of'];
    const body = s.applied.skipped.map((k) => {
      const p = plan.find((x) => x.row === k.row)!;
      return [p.raw.Account ?? '', p.raw.BPID ?? '', p.raw.Appliance ?? '', p.raw.Metric ?? '', p.raw.Ticker ?? '', p.raw.Region ?? '', p.raw.Location ?? '', p.raw.Environment ?? '', p.raw.Enabled ?? '', p.raw['Stale after (s)'] ?? '', String(k.row), k.reason, ''];
    });
    return [head, ...body];
  }
}

export function hashBams(plan: BamsImportPlan): string {
  const sig = JSON.stringify([plan.rows.map((r) => [r.row, r.state, r.target?.appliance.id ?? null, r.target?.metric.id ?? null, r.fills]), plan.review.map((g) => [g.key, g.candidates.map((c) => [c.ref, c.row_version ?? null, c.name])])]);
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < sig.length; i++) { h1 = Math.imul(h1 ^ sig.charCodeAt(i), 16777619); h2 = Math.imul(h2 + sig.charCodeAt(i), 2246822519) ^ (h2 >>> 13); }
  return `mock:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function bamsTemplateRows(): string[][] {
  return [[...BAMS_HEADERS], ['Castellan Peak Global Markets', '100482', 'SAPI-01', 'CPU utilisation %', 'BAMS.CPFX.SAPI01.CPU', 'Americas', 'Chicago', 'PROD', 'Yes', '120']];
}

/** Contract 13.7 (mock approximation from the file values): appliances whose Region is not East/West or whose Environment is empty. */
export function opsNote(rows: BamsImportRow[]): { count: number; text: string | null } {
  const seen = new Map<string, boolean>();
  for (const r of rows) {
    if (r.state === 'invalid') continue;
    const k = `${(r.values.account ?? '').toLowerCase()}|${(r.values.appliance ?? '').toLowerCase()}`;
    const reg = (r.values.region ?? '').trim().toLowerCase();
    const needs = (reg !== 'east' && reg !== 'west') || !(r.values.environment ?? '').trim();
    seen.set(k, (seen.get(k) ?? false) || needs);
  }
  const count = [...seen.values()].filter(Boolean).length;
  return { count, text: count ? `${count} ${count === 1 ? 'appliance needs' : 'appliances need'} East or West set for Operations` : null };
}

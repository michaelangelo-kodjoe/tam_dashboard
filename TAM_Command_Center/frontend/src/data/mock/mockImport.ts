// Import planning and apply computation for the MOCK adapter (pure; MockDataSource commits the effects).
// Follows docs/01_PM_SPEC.md D-37..D-48 and the API contract §10. No numeric score anywhere.
import type {
  CandidateRef, FillMap, ImportDecision, ImportFormat, ImportPlan, ImportRow, ImportRowError, ImportValues, KeptMap, ReasonText, SimilarCandidate,
} from '../../types';
import { compare, exactKey, orderHits, storedName, type Party } from './dupes';
import { COLUMNS, FileRefusal, HEADER_ALIASES, MAX_ROWS, headerKey, type Grid } from '../importFile';

export interface AcctRec { id: string; name: string; bpid: string | null; products: string | null; status: string; next_contact: string | null; notes: string | null; row_version: number }
export interface ParsedRow { row: number; values: ImportValues; raw: Record<string, string>; errors: ImportRowError[] }
export interface Parsed { rows: ParsedRow[]; warnings: ReasonText[] }

const FIELDS = ['name', 'bpid', 'products', 'status', 'next_contact', 'notes'] as const;
const KEY: Record<(typeof COLUMNS)[number], (typeof FIELDS)[number]> = {
  'Account name': 'name', BPID: 'bpid', Products: 'products', Status: 'status', 'Next contact date': 'next_contact', Notes: 'notes',
};
const SKIP_TAIL = 'This row will be skipped; fix it in the file and re-upload, or leave it out.';

function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
const colLetter = (i: number) => String.fromCharCode(65 + i);

export function parseGrid(grid: Grid): Parsed {
  const head = grid[0] ?? [];
  const map = new Map<number, (typeof FIELDS)[number]>();
  const seen = new Set<string>();
  const warnings: ReasonText[] = [];
  head.forEach((c, i) => {
    const k = headerKey(c.v);
    if (!k) return;
    const col = HEADER_ALIASES[k];
    if (!col) { warnings.push({ code: 'unknown_column', text: `Column ${colLetter(i)} "${c.v.trim()}" is ignored.` }); return; }
    if (seen.has(col)) throw new FileRefusal('header_duplicate', `The column "${col}" appears twice in the header row. Keep one.`);
    seen.add(col);
    map.set(i, KEY[col]);
  });
  if (!seen.has('Account name')) throw new FileRefusal('header_missing', 'The header row has no "Account name" column. Start from the template.');
  const rows: ParsedRow[] = [];
  for (let r = 1; r < Math.min(grid.length, 10_001); r++) {
    const cells = grid[r] ?? [];
    const raw: Record<string, string> = {};
    const formulaIn: string[] = [];
    for (const [i, f] of map) {
      const c = cells[i];
      // a formula cell is never read for its cached value (D-38)
      raw[f] = c?.formula ? '' : (c?.v ?? '');
      if (c?.formula) formulaIn.push(f);
    }
    if (formulaIn.length === 0 && FIELDS.every((f) => (raw[f] ?? '').trim() === '')) continue;
    rows.push(validateRow(r + 1, raw, formulaIn));
  }
  if (rows.length === 0) throw new FileRefusal('no_rows', 'No account rows were found in this file.');
  if (rows.length > MAX_ROWS) {
    throw new FileRefusal('too_many_rows', `This file has ${rows.length} account rows. The limit is ${MAX_ROWS} per import. Split the file and import it in parts.`, { found: rows.length, limit: MAX_ROWS });
  }
  return { rows, warnings };
}

function validateRow(row: number, raw: Record<string, string>, formulaIn: string[]): ParsedRow {
  const errors: ImportRowError[] = [];
  const err = (field: string, code: string, msg: string) => errors.push({ field, code, text: `Row ${row}: ${msg} ${SKIP_TAIL}` });
  const v: ImportValues = { name: null, bpid: null, products: null, status: null, next_contact: null, notes: null };
  for (const f of formulaIn) err(f, 'formula', `${label(f)}: formulas are not accepted; paste the value.`);
  const t = (s: string | undefined) => { const x = (s ?? '').replace(/\r\n?/g, '\n').trim(); return x === '' ? null : x; };
  const name = t(raw.name);
  if (name == null) { if (!formulaIn.includes('name')) err('name', 'required', 'Account name is required.'); }
  else {
    const n = storedName(name);
    if (n.length > 200) err('name', 'too_long', 'Account name is longer than 200 characters.'); else v.name = n;
  }
  let bpid = t(raw.bpid);
  if (bpid != null && /^\d+\.0$/.test(bpid)) bpid = bpid.slice(0, -2);
  if (bpid != null && bpid.length > 32) err('bpid', 'too_long', 'BPID is longer than 32 characters.'); else v.bpid = bpid;
  const products = t(raw.products);
  if (products != null && products.length > 500) err('products', 'too_long', 'Products is longer than 500 characters.'); else v.products = products;
  const notes = t(raw.notes);
  if (notes != null && notes.length > 20000) err('notes', 'too_long', 'Notes is longer than 20,000 characters.'); else v.notes = notes;
  const st = t(raw.status);
  if (st != null) {
    const canon = ['Active', 'Inactive'].find((s) => s.toLowerCase() === st.toLowerCase());
    if (canon) v.status = canon; else err('status', 'status_not_allowed', `Status: '${st}' is not in the list (Active, Inactive).`);
  }
  const d = t(raw.next_contact);
  if (d != null) {
    const iso = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d;
    if (realDate(iso) && (d.length === 10 || /^\d{4}-\d{2}-\d{2}[T ]/.test(d))) v.next_contact = iso;
    else err('next_contact', 'date_format', 'Next contact date: use YYYY-MM-DD.');
  }
  return { row, values: v, raw, errors };
}
const label = (f: string) => ({ name: 'Account name', bpid: 'BPID', products: 'Products', status: 'Status', next_contact: 'Next contact date', notes: 'Notes' } as Record<string, string>)[f] ?? f;

// ---- planning ------------------------------------------------------------------------------------
type Vals = { bpid: string | null; products: string | null; status: string | null; next_contact: string | null; notes: string | null };
const FILLABLE = ['bpid', 'products', 'next_contact', 'notes'] as const;

function fillKeep(file: Vals, target: Vals, targetIsAccount: boolean): { fills: FillMap; kept: KeptMap } {
  const fills: FillMap = {};
  const kept: KeptMap = {};
  for (const f of [...FILLABLE, 'status'] as const) {
    const fv = file[f];
    const tv = target[f];
    if (fv == null) continue;
    if (tv == null || tv === '') { if (f === 'status' && targetIsAccount) continue; fills[f] = fv; }
    else kept[f] = { existing: tv, file: fv, differs: tv !== fv };
  }
  return { fills, kept };
}

export interface Meta { name: string; size_bytes: number; format: ImportFormat; sheet: string | null; encoding: string | null; delimiter: string | null; extraNotes: string[] }

export function buildPlan(parsed: Parsed, accounts: AcctRec[], meta: Meta, importId: string, expiresAt: string): ImportPlan {
  const byKey = new Map(accounts.map((a) => [exactKey(a.name), a]));
  const rows: ImportRow[] = [];
  const earlierKey = new Map<string, ImportRow>();
  for (const p of parsed.rows) {
    const base: ImportRow = { row: p.row, state: 'new', values: p.values, raw: null, errors: p.errors, warnings: [], match: null, merged_into: null, candidates: [] };
    if (p.errors.length) { rows.push({ ...base, state: 'invalid', raw: p.raw }); continue; }
    const key = exactKey(p.values.name!);
    const ex = byKey.get(key);
    const vals: Vals = p.values;
    if (ex) {
      const { fills, kept } = fillKeep(vals, ex, true);
      delete fills.status;
      const notes = ex.status === 'Inactive' ? ['Existing account is Inactive and stays Inactive'] : [];
      const warnings: ReasonText[] = [];
      if (p.values.bpid && ex.bpid && p.values.bpid.toLowerCase() !== ex.bpid.toLowerCase()) warnings.push({ code: 'different_bpid', text: `Different BPID: file ${p.values.bpid}, existing ${ex.bpid}` });
      const r: ImportRow = { ...base, state: 'update', unchanged: Object.keys(fills).length === 0, warnings, match: { kind: 'exact', account: { id: ex.id, name: ex.name, status: ex.status, row_version: ex.row_version }, fills, kept, notes, reasons: [{ code: 'exact_name', text: 'Same name (case and spacing ignored)' }] } };
      rows.push(r);
      if (!earlierKey.has(key)) earlierKey.set(key, r);
      continue;
    }
    const first = earlierKey.get(key);
    if (first) {
      rows.push({ ...base, state: first.state === 'update' ? 'update' : 'new', unchanged: first.state === 'update' ? false : undefined, merged_into: { row: first.row }, match: first.match });
      continue;
    }
    const cands: (SimilarCandidate & { _id: string })[] = [];
    const me: Party = { name: p.values.name!, bpid: p.values.bpid };
    for (const a of accounts) {
      const h = compare(me, { name: a.name, bpid: a.bpid });
      if (!h) continue;
      const fk = fillKeep(vals, a, true);
      const notes = a.status === 'Inactive' ? ['Existing account is Inactive and stays Inactive'] : [];
      delete fk.fills.status;
      cands.push({ _id: a.id, ref: { type: 'account', id: a.id }, name: a.name, bpid: a.bpid, products: a.products, status: a.status, next_contact: a.next_contact, row_version: a.row_version, ...h, fills: fk.fills, kept: fk.kept, notes });
    }
    for (const e of rows) {
      if (e.state === 'invalid' || e.merged_into || !e.values.name) continue;
      const h = compare(me, { name: e.values.name, bpid: e.values.bpid });
      if (!h) continue;
      const fk = fillKeep(vals, e.values, false);
      cands.push({ _id: `row:${String(e.row).padStart(6, '0')}`, ref: { type: 'row', row: e.row }, name: e.values.name, bpid: e.values.bpid, products: e.values.products, status: e.values.status, next_contact: e.values.next_contact, ...h, fills: fk.fills, kept: fk.kept, notes: [] });
    }
    const ordered = orderHits(cands.map((c) => ({ ...c, id: c._id }))).map(({ id: _i, _id, ...c }) => { void _i; void _id; return c as SimilarCandidate; });
    const r: ImportRow = ordered.length ? { ...base, state: 'needs_review', candidates: ordered } : base;
    rows.push(r);
    earlierKey.set(key, r);
  }
  const count = (s: ImportRow['state']) => rows.filter((r) => r.state === s).length;
  const unchanged = rows.filter((r) => r.state === 'update' && r.unchanged).length;
  const c = { rows: rows.length, new: count('new'), updates: count('update'), needs_review: count('needs_review'), invalid: count('invalid'), valid: 0, unchanged };
  c.valid = c.new + c.updates + c.needs_review;
  return {
    import_id: importId, plan_hash: hashPlan(rows), expires_at: expiresAt,
    file: { name: meta.name, size_bytes: meta.size_bytes, rows_found: rows.length, format: meta.format, sheet: meta.sheet, encoding: meta.encoding, delimiter: meta.delimiter, notes: meta.extraNotes },
    limits: { max_rows: MAX_ROWS, max_candidates: 5 },
    counts: c,
    warnings: parsed.warnings,
    rows,
  };
}

export function hashPlan(rows: ImportRow[]): string {
  const sig = JSON.stringify(rows.map((r) => [r.row, r.state, r.merged_into?.row ?? null, r.match ? [r.match.account.id, r.match.account.row_version, r.match.account.name, r.match.fills] : null, r.candidates.map((c) => [c.ref, c.row_version ?? null, c.name, c.fills])]));
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < sig.length; i++) { h1 = Math.imul(h1 ^ sig.charCodeAt(i), 16777619); h2 = Math.imul(h2 + sig.charCodeAt(i), 2246822519) ^ (h2 >>> 13); }
  return `mock:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

// ---- decisions and apply ------------------------------------------------------------------------
export const refKey = (r: CandidateRef) => (r.type === 'account' ? `a:${r.id}` : `r:${r.row}`);

export interface Effects {
  creates: { key: number; values: ImportValues; rows: number[] }[];
  updates: { id: string; fills: FillMap; rows: number[] }[];
  unchanged: number;
  skipped: { row: number; name: string | null; kind: 'invalid' | 'by_user'; reason: string }[];
  breakdown: Record<string, number>;
}

/** Throws nothing: returns missing/invalid information the caller maps to 409/422. */
export function checkDecisions(plan: ImportPlan, decisions: ImportDecision[]): { unresolved: number[]; invalid: string | null } {
  const need = plan.rows.filter((r) => r.state === 'needs_review');
  const byRow = new Map<number, ImportDecision>();
  for (const d of decisions) {
    if (byRow.has(d.row)) return { unresolved: [], invalid: `Row ${d.row} has two decisions.` };
    byRow.set(d.row, d);
  }
  for (const d of decisions) if (!need.some((r) => r.row === d.row)) return { unresolved: [], invalid: `Row ${d.row} does not need a decision.` };
  const unresolved: number[] = [];
  for (const r of need) {
    const d = byRow.get(r.row);
    if (!d) { unresolved.push(r.row); continue; }
    if (d.choice === 'same') {
      if (!d.target) return { unresolved: [], invalid: `Row ${r.row}: choose which account it is the same as.` };
      if (!r.candidates.some((c) => refKey(c.ref) === refKey(d.target!))) return { unresolved: [], invalid: `Row ${r.row}: the chosen account is not one of the candidates.`, };
      if (d.target.type === 'row' && byRow.get(d.target.row)?.choice === 'skip') return { unresolved: [], invalid: `Row ${r.row}: it cannot be merged into row ${d.target.row}, which is skipped.` };
    } else if (d.target) return { unresolved: [], invalid: `Row ${r.row}: a target only applies to Same account.` };
  }
  return { unresolved, invalid: null };
}

export function computeEffects(plan: ImportPlan, decisions: ImportDecision[], accounts: AcctRec[]): Effects {
  const dec = new Map(decisions.map((d) => [d.row, d]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  type Target = { kind: 'account'; id: string } | { kind: 'new'; key: number };
  const res = new Map<number, Target | null>();
  const pend = new Map<string, { fills: FillMap; rows: number[]; cur: Vals }>();
  const news: { key: number; values: ImportValues; rows: number[] }[] = [];
  const skipped: Effects['skipped'] = [];
  const bd: Record<string, number> = { created_new: 0, created_marked_different: 0, updated_exact: 0, updated_marked_same: 0, skipped_invalid: 0, skipped_by_user: 0 };

  const fillInto = (t: Target, v: ImportValues, row: number) => {
    if (t.kind === 'account') {
      const a = byId.get(t.id)!;
      let p = pend.get(t.id);
      if (!p) { p = { fills: {}, rows: [], cur: { bpid: a.bpid, products: a.products, status: a.status, next_contact: a.next_contact, notes: a.notes } }; pend.set(t.id, p); }
      p.rows.push(row);
      for (const f of FILLABLE) if (v[f] != null && (p.cur[f] == null || p.cur[f] === '')) { p.cur[f] = v[f]; p.fills[f] = v[f]!; }
    } else {
      const n = news.find((x) => x.key === t.key)!;
      n.rows.push(row);
      for (const f of [...FILLABLE, 'status'] as const) if (v[f] != null && n.values[f] == null) n.values[f] = v[f];
    }
  };
  const createNew = (r: ImportRow): Target => {
    const key = news.length;
    news.push({ key, values: { ...r.values, status: r.values.status ?? 'Active' }, rows: [r.row] });
    return { kind: 'new', key };
  };

  for (const r of plan.rows) {
    if (r.state === 'invalid') {
      skipped.push({ row: r.row, name: r.values.name ?? r.raw?.name ?? null, kind: 'invalid', reason: r.errors.map((e) => e.text.replace(/^Row \d+: /, '').replace(/ This row will be skipped.*$/, '')).join(' ') });
      bd.skipped_invalid++; res.set(r.row, null); continue;
    }
    if (r.merged_into) {
      const t = res.get(r.merged_into.row) ?? null;
      if (!t) { skipped.push({ row: r.row, name: r.values.name, kind: 'by_user', reason: `Merged into row ${r.merged_into.row}, which was not imported` }); bd.skipped_by_user++; res.set(r.row, null); continue; }
      fillInto(t, r.values, r.row); res.set(r.row, t); continue;
    }
    if (r.state === 'update') { const t: Target = { kind: 'account', id: r.match!.account.id }; fillInto(t, r.values, r.row); res.set(r.row, t); bd.updated_exact++; continue; }
    if (r.state === 'new') { res.set(r.row, createNew(r)); bd.created_new++; continue; }
    const d = dec.get(r.row)!;
    if (d.choice === 'skip') {
      const top = r.candidates[0];
      skipped.push({ row: r.row, name: r.values.name, kind: 'by_user', reason: `Skipped by you (possible duplicate of ${top ? top.name : 'another account'})` });
      bd.skipped_by_user++; res.set(r.row, null);
    } else if (d.choice === 'different') { res.set(r.row, createNew(r)); bd.created_marked_different++; }
    else if (d.target!.type === 'account') { const t: Target = { kind: 'account', id: d.target!.id }; fillInto(t, r.values, r.row); res.set(r.row, t); bd.updated_marked_same++; }
    else { const t = res.get(d.target!.row) ?? null; if (t) { fillInto(t, r.values, r.row); res.set(r.row, t); bd.updated_marked_same++; } else { skipped.push({ row: r.row, name: r.values.name, kind: 'by_user', reason: `Merged into row ${d.target!.row}, which was not imported` }); bd.skipped_by_user++; res.set(r.row, null); } }
  }
  const updates = [...pend.entries()].filter(([, p]) => Object.keys(p.fills).length).map(([id, p]) => ({ id, fills: p.fills, rows: p.rows }));
  const unchanged = [...pend.values()].filter((p) => Object.keys(p.fills).length === 0).length;
  return { creates: news, updates, unchanged, skipped, breakdown: bd };
}

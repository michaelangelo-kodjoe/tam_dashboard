// Pure state helpers for the BAMS appliance import page (docs/04_API_CONTRACT.md §12, PM D-63..D-72).
// Decisions are per flagged appliance (group key), not per row. Nothing is preselected (D-67); Apply stays
// locked until every flagged appliance has a decision (D-68). Unit tested in importState.test.ts.
import { DataSourceError } from '../../data/DataSource';
import { describeFileRefusal } from '../import/importState';
import type { BamsApplyInput, BamsCandidate, BamsCandidateRef, BamsChoice, BamsImportPlan, BamsImportResult, BamsImportRow, BamsReviewGroup, BamsRowState } from '../../bamsTypes';

export type Decisions = Record<string, { choice: BamsChoice; target?: BamsCandidateRef }>;
export type Step = 'file' | 'preview' | 'review' | 'result';

export const refKey = (r: BamsCandidateRef) => (r.type === 'appliance' ? `a:${r.id}` : `g:${r.key}`);
export const sameRef = (a?: BamsCandidateRef, b?: BamsCandidateRef) => !!a && !!b && refKey(a) === refKey(b);

/** "Same" onto an earlier group of this file is disabled when that group is Skip. */
export function candidateDisabled(c: BamsCandidate, decisions: Decisions): boolean {
  return c.ref.type === 'group' && decisions[c.ref.key]?.choice === 'skip';
}
export function isResolved(g: BamsReviewGroup, decisions: Decisions): boolean {
  const d = decisions[g.key];
  if (!d) return false;
  if (d.choice !== 'same') return true;
  const cand = g.candidates.find((c) => sameRef(c.ref, d.target));
  return !!cand && !candidateDisabled(cand, decisions);
}
export const unresolvedKeys = (plan: BamsImportPlan, decisions: Decisions) => plan.review.filter((g) => !isResolved(g, decisions)).map((g) => g.key);
export const resolvedCount = (plan: BamsImportPlan, decisions: Decisions) => plan.review.filter((g) => isResolved(g, decisions)).length;
export const canApply = (plan: BamsImportPlan, decisions: Decisions) => plan.counts.valid > 0 && unresolvedKeys(plan, decisions).length === 0;

/** Choosing "Same appliance" targets the candidate currently compared (`viewed`); other choices carry no target. */
export function choose(decisions: Decisions, g: BamsReviewGroup, choice: BamsChoice, viewed: BamsCandidateRef): Decisions {
  const next = { ...decisions };
  if (choice === 'same') {
    const cand = g.candidates.find((c) => sameRef(c.ref, viewed));
    next[g.key] = cand && !candidateDisabled(cand, decisions) ? { choice, target: viewed } : { choice };
  } else next[g.key] = { choice };
  return next;
}

export function toRequest(plan: BamsImportPlan, decisions: Decisions): BamsApplyInput {
  return {
    import_id: plan.import_id, plan_hash: plan.plan_hash, confirm: true,
    decisions: plan.review.map((g) => { const d = decisions[g.key]; return d.choice === 'same' ? { key: g.key, choice: 'same', target: d.target } : { key: g.key, choice: d.choice }; }),
  };
}

const candSig = (g: BamsReviewGroup) => JSON.stringify(g.candidates.map((c) => [refKey(c.ref), c.name, c.row_version ?? null, c.strength]));
/** After preview_stale: keep decisions whose group and candidates are unchanged; report the rest. */
export function carryDecisions(oldPlan: BamsImportPlan, fresh: BamsImportPlan, decisions: Decisions): { decisions: Decisions; changed: string[] } {
  const old = new Map(oldPlan.review.map((g) => [g.key, g]));
  const out: Decisions = {};
  const changed: string[] = [];
  for (const g of fresh.review) {
    const o = old.get(g.key);
    if (o && decisions[g.key] && candSig(o) === candSig(g)) out[g.key] = decisions[g.key]; else changed.push(g.key);
  }
  return { decisions: out, changed };
}

// ---- preview grouping and filters ---------------------------------------------------------------
export type Filter = 'all' | BamsRowState;
export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'new', label: 'New' }, { id: 'update', label: 'Updated' }, { id: 'unchanged', label: 'Unchanged' }, { id: 'needs_review', label: 'Needs review' }, { id: 'invalid', label: 'Invalid' },
];
export function filterCount(plan: BamsImportPlan, f: Filter): number {
  const c = plan.counts;
  return f === 'all' ? c.rows : f === 'new' ? c.new : f === 'update' ? c.updates : f === 'unchanged' ? c.unchanged : f === 'needs_review' ? c.needs_review : c.invalid;
}

export interface PreviewGroup { key: string; account: string | null; appliance: string | null; badge: 'new' | 'fills' | 'unchanged' | 'review' | null; sub: string; rows: BamsImportRow[]; orphan: boolean }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Rows grouped by account and appliance, in file order. Invalid rows with no usable account go to one trailing group. */
export function groupRows(plan: BamsImportPlan, filter: Filter, search: string): PreviewGroup[] {
  const needle = search.trim().toLowerCase();
  const rows = plan.rows.filter((r) => (filter === 'all' || r.state === filter)
    && (!needle || [r.values.account, r.values.appliance, r.values.ticker, r.target?.client_name].some((x) => (x ?? '').toLowerCase().includes(needle))));
  const groups = new Map<string, PreviewGroup>();
  const order: string[] = [];
  for (const r of rows) {
    const account = r.target?.client_name ?? null;
    const orphan = !account || !r.values.appliance;
    const key = orphan ? '__orphan' : `${account}|${r.values.appliance!.toLowerCase()}`;
    if (!groups.has(key)) { groups.set(key, { key, account, appliance: orphan ? null : r.values.appliance, badge: null, sub: '', rows: [], orphan }); order.push(key); }
    groups.get(key)!.rows.push(r);
  }
  const reviewBy = new Map(plan.review.map((g) => [g.key, g]));
  for (const g of groups.values()) {
    if (g.orphan) { g.sub = 'Shown here because no valid account or appliance could be formed'; continue; }
    const valid = g.rows.filter((r) => r.state !== 'invalid');
    const first = valid[0];
    if (!first) continue;
    if (first.state === 'needs_review') {
      g.badge = 'review';
      const rg = reviewBy.get(first.review_key ?? '');
      g.sub = rg?.candidates[0] ? `Similar to ${rg.candidates[0].name} in this account` : 'Similar to another appliance in this account';
    } else if (first.target?.appliance.is_new) g.badge = 'new';
    else if (valid.some((r) => r.state === 'update')) {
      g.badge = 'fills';
      const f = Object.entries(valid.find((r) => Object.keys(r.fills).length)?.fills ?? {});
      g.sub = f.map(([k, v]) => `${cap(k)} blank, file gives ${v}`).join('; ');
    } else { g.badge = 'unchanged'; g.sub = 'Existing appliance'; }
  }
  const out = order.map((k) => groups.get(k)!);
  return [...out.filter((g) => !g.orphan), ...out.filter((g) => g.orphan)];
}

// ---- errors -------------------------------------------------------------------------------------
export type ErrorKind = 'file' | 'expired' | 'stale' | 'unresolved' | 'applied' | 'backup' | 'failed' | 'network' | 'generic';
export interface MappedError { kind: ErrorKind; title: string; detail?: string; keys?: string[]; result?: BamsImportResult; failed?: { row?: number; reason?: string; backup?: string } }

export function mapBamsError(e: unknown): MappedError {
  if (!(e instanceof DataSourceError)) return { kind: 'generic', title: 'Something went wrong. Nothing was changed; try again.' };
  const d = e.details;
  switch (e.code) {
    case 'invalid_file': {
      const reason = typeof d?.reason === 'string' ? d.reason : undefined;
      if (reason === 'header_missing') {
        const missing = Array.isArray(d?.missing) ? (d!.missing as string[]).join(', ') : '';
        const found = Array.isArray(d?.found) ? (d!.found as string[]).join(', ') : '';
        return { kind: 'file', title: missing ? `Missing required column: ${missing}` : e.message, detail: `${found ? `Found: ${found}. ` : ''}Download the template to see every column name.` };
      }
      if (reason === 'too_many_rows') {
        const found = typeof d?.found === 'number' ? d.found : null;
        const limit = typeof d?.limit === 'number' ? d.limit : 500;
        return { kind: 'file', title: found ? `Too many rows: ${found.toLocaleString('en-US')} data rows, limit is ${limit}` : `Too many rows: the limit is ${limit}`, detail: 'Split the file and import it in parts.' };
      }
      if (reason === 'unsupported_type' || reason === 'not_xlsx' || reason === 'not_csv') return { kind: 'file', title: 'This is not an .xlsx or .csv file', detail: 'Only .xlsx and .csv are accepted.' };
      return { kind: 'file', title: describeFileRefusal(reason, e.message, d).replace(/5 MB/, '5 MiB') };
    }
    case 'payload_too_large': return { kind: 'file', title: 'This file is larger than 5 MiB', detail: 'Split it and import it in parts.' };
    case 'import_expired': return { kind: 'expired', title: 'This preview has expired.', detail: 'Choose the file again to preview it. Nothing was written.' };
    case 'preview_stale': return { kind: 'stale', title: 'Appliances or tickers changed since you opened the preview.', detail: 'The preview was refreshed; check the rows below.' };
    case 'unresolved_duplicates': {
      const keys = Array.isArray(d?.keys) ? (d!.keys as string[]) : [];
      return { kind: 'unresolved', keys, title: keys.length ? `${keys.length} similar ${keys.length === 1 ? 'appliance still needs' : 'appliances still need'} a decision.` : 'Some similar appliances still need a decision.' };
    }
    case 'already_applied': return { kind: 'applied', title: 'This import was already applied. Nothing more was written.', result: d?.result as BamsImportResult | undefined };
    case 'backup_failed': return { kind: 'backup', title: 'The safety backup could not be written, so nothing was changed.', detail: 'Check free disk space and try again.' };
    case 'import_failed': return { kind: 'failed', title: 'Import failed. Nothing was imported.', failed: { row: typeof d?.row === 'number' ? d.row : undefined, reason: typeof d?.reason === 'string' ? d.reason : undefined, backup: typeof d?.backup === 'string' ? d.backup : undefined } };
    case 'network': return { kind: 'network', title: e.message };
    default: return { kind: 'generic', title: e.message || 'Something went wrong. Nothing was changed; try again.' };
  }
}

/** Open BAMS link: the touched accounts, comma separated (contract §12.4). */
export function openBamsPath(r: BamsImportResult | null): string {
  const ids = r?.touched_accounts.map((a) => a.id) ?? [];
  return ids.length ? `/bams?account=${ids.map(encodeURIComponent).join(',')}` : '/bams';
}

// Pure state helpers for the import wizard (no React): decision rules (D-43), apply gating (D-44),
// decision carry-over after preview_stale, filters and error mapping. Everything here is unit tested.
import { DataSourceError } from '../../data/DataSource';
import type { CandidateRef, ImportChoice, ImportDecision, ImportPlan, ImportResult, ImportRow, SimilarCandidate } from '../../types';

export type Decisions = Record<number, { choice: ImportChoice; target?: CandidateRef }>;
export type Step = 'file' | 'preview' | 'review' | 'result';

export const refKey = (r: CandidateRef) => (r.type === 'account' ? `a:${r.id}` : `r:${r.row}`);
export const sameRef = (a: CandidateRef | undefined, b: CandidateRef | undefined) => !!a && !!b && refKey(a) === refKey(b);

export function flaggedRows(plan: ImportPlan): ImportRow[] {
  return plan.rows.filter((r) => r.state === 'needs_review');
}

/** "Same account" onto an earlier row is disabled when that row is Skip (invalid rows are never candidates). */
export function candidateDisabled(c: SimilarCandidate, decisions: Decisions): boolean {
  return c.ref.type === 'row' && decisions[c.ref.row]?.choice === 'skip';
}

export function isResolved(row: ImportRow, decisions: Decisions): boolean {
  const d = decisions[row.row];
  if (!d) return false;
  if (d.choice !== 'same') return true;
  const t = d.target;
  if (!t) return false;
  const cand = row.candidates.find((c) => sameRef(c.ref, t));
  return !!cand && !candidateDisabled(cand, decisions);
}

export function resolvedCount(plan: ImportPlan, decisions: Decisions): number {
  return flaggedRows(plan).filter((r) => isResolved(r, decisions)).length;
}
export function unresolvedRows(plan: ImportPlan, decisions: Decisions): number[] {
  return flaggedRows(plan).filter((r) => !isResolved(r, decisions)).map((r) => r.row);
}
export function canApply(plan: ImportPlan, decisions: Decisions): boolean {
  return plan.counts.valid > 0 && unresolvedRows(plan, decisions).length === 0;
}

/** Nothing is ever preselected; choosing "Same account" with exactly one candidate picks that candidate. */
export function chooseOption(plan: ImportPlan, decisions: Decisions, row: number, choice: ImportChoice): Decisions {
  const r = plan.rows.find((x) => x.row === row);
  if (!r) return decisions;
  const next = { ...decisions };
  if (choice === 'same') {
    const usable = r.candidates.filter((c) => !candidateDisabled(c, decisions));
    const keep = decisions[row]?.target;
    const target = keep && usable.some((c) => sameRef(c.ref, keep)) ? keep : usable.length === 1 && r.candidates.length === 1 ? usable[0].ref : undefined;
    next[row] = target ? { choice, target } : { choice };
  } else next[row] = { choice };
  return next;
}
export function chooseTarget(decisions: Decisions, row: number, target: CandidateRef): Decisions {
  return { ...decisions, [row]: { choice: 'same', target } };
}

export function toRequest(plan: ImportPlan, decisions: Decisions) {
  const list: ImportDecision[] = flaggedRows(plan).map((r) => {
    const d = decisions[r.row];
    return d.choice === 'same' ? { row: r.row, choice: 'same', target: d.target } : { row: r.row, choice: d.choice };
  });
  return { import_id: plan.import_id, plan_hash: plan.plan_hash, confirm: true as const, decisions: list };
}

const candSig = (r: ImportRow) => JSON.stringify(r.candidates.map((c) => [refKey(c.ref), c.name, c.row_version ?? null, c.strength]));
/** After preview_stale: keep decisions for rows whose candidate set is unchanged; report the rest. */
export function carryDecisions(oldPlan: ImportPlan, fresh: ImportPlan, decisions: Decisions): { decisions: Decisions; changed: number[] } {
  const oldRows = new Map(oldPlan.rows.map((r) => [r.row, r]));
  const out: Decisions = {};
  const changed: number[] = [];
  for (const r of flaggedRows(fresh)) {
    const o = oldRows.get(r.row);
    const d = decisions[r.row];
    if (o && o.state === 'needs_review' && d && candSig(o) === candSig(r)) out[r.row] = d;
    else changed.push(r.row);
  }
  return { decisions: out, changed };
}

export type Filter = 'all' | 'new' | 'update' | 'needs_review' | 'invalid';
export function filterRows(plan: ImportPlan, f: Filter): ImportRow[] {
  return f === 'all' ? plan.rows : plan.rows.filter((r) => r.state === f);
}
export function unchangedCount(plan: ImportPlan): number {
  return plan.counts.unchanged ?? plan.rows.filter((r) => r.state === 'update' && (r.unchanged ?? (!r.merged_into && !!r.match && Object.keys(r.match.fills).length === 0))).length;
}

export const FIELD_LABEL: Record<string, string> = { name: 'Account name', bpid: 'BPID', products: 'Products', status: 'Status', next_contact: 'Next contact date', notes: 'Notes' };

/** Where closing the wizard must ask first: a file was inspected and nothing was applied yet. */
export function needsDiscardGuard(step: Step, plan: ImportPlan | null, result: ImportResult | null): boolean {
  return !result && !!plan && step !== 'result';
}

// ---- error mapping ------------------------------------------------------------------------------
export type ErrorKind = 'file' | 'expired' | 'stale' | 'unresolved' | 'applied' | 'backup' | 'network' | 'generic';
export interface MappedError { kind: ErrorKind; message: string; rows?: number[]; result?: ImportResult }

const num = (n: number) => n.toLocaleString('en-US');
export function describeFileRefusal(reason: string | undefined, fallback: string, d: Record<string, unknown> | undefined): string {
  switch (reason) {
    case 'unsupported_type': return 'Only .xlsx and .csv files can be imported.';
    case 'not_xlsx': return 'This file is named .xlsx but is not a real Excel workbook (old .xls files are not accepted). Save it as .xlsx or .csv and try again.';
    case 'not_csv': return 'This file is not a spreadsheet or a CSV text file.';
    case 'too_large': return 'This file is larger than 5 MB. Split it and import it in parts.';
    case 'encrypted': return 'This file is encrypted or password protected. Remove the password and try again.';
    case 'corrupt': return 'This file is damaged or is not a real .xlsx or .csv file.';
    case 'zip_unsafe': case 'xml_unsafe': return 'This workbook cannot be read safely. Save it again as a plain .xlsx or .csv.';
    case 'macros': return 'This workbook contains macros, which are not accepted. Save it as a plain .xlsx or .csv.';
    case 'external_links': return 'This workbook links to other files, which is not accepted. Remove the links and try again.';
    case 'embedded_objects': return 'This workbook contains embedded objects, which are not accepted. Remove them and try again.';
    case 'sheet_missing': return fallback || 'No sheet named "Accounts" was found. Start from the template.';
    case 'header_missing': return fallback || 'The header row has no "Account name" column. Start from the template.';
    case 'header_duplicate': return fallback || 'A column name appears twice in the header row. Keep one.';
    case 'no_rows': return 'No account rows were found in this file.';
    case 'too_many_rows': {
      const found = typeof d?.found === 'number' ? ` has ${num(d.found)} account rows. The limit` : ' has too many account rows. The limit';
      const limit = typeof d?.limit === 'number' ? d.limit : 500;
      return `This file${found} is ${num(limit)} per import. Split the file and import it in parts.`;
    }
    default: return fallback || 'This file could not be read.';
  }
}

export function mapImportError(e: unknown): MappedError {
  if (!(e instanceof DataSourceError)) return { kind: 'generic', message: 'Something went wrong. Nothing was changed; try again.' };
  const d = e.details;
  switch (e.code) {
    case 'invalid_file': return { kind: 'file', message: describeFileRefusal(typeof d?.reason === 'string' ? d.reason : undefined, e.message, d) };
    case 'payload_too_large': return { kind: 'file', message: describeFileRefusal('too_large', e.message, d) };
    case 'import_expired': return { kind: 'expired', message: 'This import timed out. Choose the file again.' };
    case 'preview_stale': return { kind: 'stale', message: 'Accounts changed since you opened the preview. The preview was refreshed; check the rows marked below.' };
    case 'unresolved_duplicates': {
      const rows = Array.isArray(d?.rows) ? (d!.rows as number[]) : [];
      return { kind: 'unresolved', rows, message: rows.length ? `${rows.length} similar ${rows.length === 1 ? 'row still needs' : 'rows still need'} a decision: row ${rows.join(', ')}.` : 'Some similar rows still need a decision.' };
    }
    case 'already_applied': return { kind: 'applied', message: 'This import was already applied. Nothing more was written.', result: (d?.result as ImportResult | undefined) };
    case 'backup_failed': return { kind: 'backup', message: 'The safety backup could not be written, so nothing was changed. Check free disk space and try again.' };
    case 'network': return { kind: 'network', message: e.message };
    default: return { kind: 'generic', message: e.message || 'Something went wrong. Nothing was changed; try again.' };
  }
}

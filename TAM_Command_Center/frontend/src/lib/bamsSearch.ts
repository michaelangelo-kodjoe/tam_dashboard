// BAMS dashboard search suggestions (ported from the workstation build): appliances, accounts, metrics and
// tickers that match what is typed, best matches first, plus a final "search all fields" choice.
import type { BamsRow, BamsState } from '../bamsTypes';

export type SuggestionKind = 'appliance' | 'account' | 'metric' | 'search';
export interface Suggestion { id: string; kind: SuggestionKind; label: string; meta: string; value: string; score?: number }
export const KIND_LABEL: Record<SuggestionKind, string> = { appliance: 'Appliance', account: 'Account', metric: 'Metric', search: 'Search' };
const MAX = 8;

export function buildSuggestions(filters: BamsState['filters'] | undefined, rows: Pick<BamsRow, 'ticker'>[] | undefined, text: string): Suggestion[] {
  const q = text.trim().toLocaleLowerCase();
  if (!filters || !q) return [];
  const out: Suggestion[] = [];
  const add = (hay: string | null | undefined, s: Suggestion) => {
    const h = (hay ?? '').toLocaleLowerCase();
    const score = h.startsWith(q) ? 0 : h.includes(q) ? 1 : 9;
    if (score < 9) out.push({ ...s, score });
  };
  for (const o of filters.objects) add(`${o.name} ${o.client_name}`, { id: `appliance:${o.id}`, kind: 'appliance', label: o.name, meta: o.client_name, value: o.id });
  for (const a of filters.accounts) add(a.name, { id: `account:${a.id}`, kind: 'account', label: a.name, meta: 'Account', value: a.id });
  for (const m of filters.metrics) add(m, { id: `metric:${m}`, kind: 'metric', label: m, meta: 'Metric', value: m });
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    const t = (r.ticker ?? '').trim();
    if (t && !seen.has(t)) { seen.add(t); add(t, { id: `ticker:${t}`, kind: 'search', label: t, meta: 'Ticker', value: t }); }
  }
  return out.sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)).slice(0, MAX);
}

/** Suggestions plus the always-present "search all fields" entry. */
export function searchChoices(suggestions: Suggestion[], text: string): Suggestion[] {
  const t = text.trim();
  return t ? [...suggestions, { id: 'search:all', kind: 'search', label: t, meta: 'Search all fields', value: t }] : [...suggestions];
}

/** URL patch for choosing a suggestion: appliance/account/metric become filters and clear the text; others search the text. */
export function choiceQuery(c: Suggestion): Record<string, string | null> {
  switch (c.kind) {
    case 'appliance': return { object_id: c.value, account: null, q: null };
    case 'account': return { account: c.value, object_id: null, q: null };
    case 'metric': return { metric: c.value, q: null };
    default: return { q: c.value };
  }
}

// Duplicate-name matcher for the MOCK adapter: a TypeScript port of docs/01_PM_SPEC.md D-40 to D-42
// (the backend's server/dupes.py is the reference; parity is proven by dupes.golden.test.ts against
// the shared golden fixture). Pure functions, no I/O, deterministic, no numeric score anywhere.
import type { MatchStrength, ReasonText } from '../../types';

export interface Party { name: string; bpid: string | null }
export interface Hit { strength: MatchStrength; reasons: ReasonText[]; differences: ReasonText[] }

export const NOISE = new Set('ltd limited inc incorporated llc llp lp plc group holdings holding the co company corp corporation and sa ag gmbh nv bv pty pte srl'.split(' '));
export const WEAK = new Set(
  'capital partners management mgmt asset assets investment investments global international financial finance bank fund funds trust securities insurance services advisory advisors markets trading pension credit union mutual reinsurance'.split(' '),
);

const casefold = (s: string) => s.toLowerCase().replace(/ß/g, 'ss');

/** Unicode NFC, trim, collapse whitespace runs, casefold (D-40). */
export function exactKey(name: string): string {
  return casefold(name.normalize('NFC').replace(/\s+/g, ' ').trim());
}

/** Stored form of a name: trimmed, whitespace runs collapsed, control characters removed. */
export function storedName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

export function matchTokens(name: string): { all: string[]; core: string[] } {
  const base = casefold(name.normalize('NFKD').replace(/\p{M}/gu, ''))
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const all = base ? base.split(' ') : [];
  const core = all.filter((t) => !NOISE.has(t));
  return { all, core: core.length ? core : all };
}

/** Optimal string alignment (restricted Damerau-Levenshtein) distance. */
export function osa(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function isAbbrev(x: string, y: string): boolean {
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 3 || l.length < s.length + 2 || s[0] !== l[0] || s === l) return false;
  let i = 0;
  for (const ch of l) if (ch === s[i]) i++;
  return i === s.length;
}

function isNear(x: string, y: string): boolean {
  if (x === y || x.length < 5 || y.length < 5 || /\d/.test(x + y)) return false; // tokens with digits are identifiers
  const longer = Math.max(x.length, y.length);
  return osa(x, y) <= (longer >= 9 ? 2 : 1);
}

type Kind = 'identical' | 'split' | 'abbreviation' | 'near';
interface Pair { a: number[]; b: number[]; kind: Kind; ta: string; tb: string }

function pairTokens(A: string[], B: string[]): Pair[] {
  const ua = new Set(A.keys());
  const ub = new Set(B.keys());
  const out: Pair[] = [];
  const take = (a: number[], b: number[], kind: Kind) => {
    a.forEach((i) => ua.delete(i));
    b.forEach((j) => ub.delete(j));
    out.push({ a, b, kind, ta: a.map((i) => A[i]).join(' '), tb: b.map((j) => B[j]).join(' ') });
  };
  for (const i of [...ua]) for (const j of [...ub]) if (ua.has(i) && ub.has(j) && A[i] === B[j]) { take([i], [j], 'identical'); break; }
  for (const i of [...ua]) {
    if (!ua.has(i) || !ua.has(i + 1)) continue;
    for (const j of [...ub]) if (ub.has(j) && A[i] + A[i + 1] === B[j]) { take([i, i + 1], [j], 'split'); break; }
  }
  for (const j of [...ub]) {
    if (!ub.has(j) || !ub.has(j + 1)) continue;
    for (const i of [...ua]) if (ua.has(i) && B[j] + B[j + 1] === A[i]) { take([i], [j, j + 1], 'split'); break; }
  }
  for (const i of [...ua]) for (const j of [...ub]) if (ua.has(i) && ub.has(j) && isAbbrev(A[i], B[j])) { take([i], [j], 'abbreviation'); break; }
  for (const i of [...ua]) for (const j of [...ub]) if (ua.has(i) && ub.has(j) && isNear(A[i], B[j])) { take([i], [j], 'near'); break; }
  return out;
}

const cap = (s: string) => s.replace(/(^|\s)(\p{L})/gu, (_m, p, c: string) => p + c.toUpperCase());
const bpidKey = (b: string | null) => (b == null ? '' : casefold(b.trim()));

function isStrong(p: Pair): boolean {
  const words = [...p.ta.split(' '), ...p.tb.split(' ')];
  const lens = [p.ta.replace(/ /g, '').length, p.tb.replace(/ /g, '').length];
  return Math.min(...lens) >= 3 && !words.some((w) => WEAK.has(w));
}

/**
 * Compare a new/file party `a` with an existing/earlier party `b`. Returns null when nothing
 * flags. Exact-key equality is the caller's concern (D-40): it is not a candidate.
 */
export function compare(a: Party, b: Party): Hit | null {
  const ta = matchTokens(a.name);
  const tb = matchTokens(b.name);
  const A = ta.core;
  const B = tb.core;
  if (!A.length || !B.length) return null;
  const pairs = pairTokens(A, B);
  const pairedA = new Set(pairs.flatMap((p) => p.a));
  const pairedB = new Set(pairs.flatMap((p) => p.b));
  const strong = pairs.filter(isStrong);

  const r1 = A.join(' ') === B.join(' ');
  const longerIsA = A.length >= B.length;
  const [L, S] = longerIsA ? [A, B] : [B, A];
  const [pL, pS] = longerIsA ? [pairedA, pairedB] : [pairedB, pairedA];
  const allLongerPaired = L.every((_, i) => pL.has(i));
  const r2 = !r1 && allLongerPaired && pairs.some((p) => p.kind !== 'identical');
  const allShorterPaired = S.every((_, i) => pS.has(i));
  const r3 = !r1 && !r2 && allShorterPaired && L.length > S.length && !pairs.some((p) => p.kind === 'split')
    && S.some((_, i) => strong.some((p) => (longerIsA ? p.b : p.a).includes(i)));
  const r4 = strong.length >= 1;
  const ja = A.join(' ');
  const jb = B.join(' ');
  const longerLen = Math.max(ja.length, jb.length);
  const digits = (s: string) => s.replace(/\D/g, '');
  const r5 = !r1 && !r2 && longerLen >= 6 && digits(ja) === digits(jb) && osa(ja, jb) <= Math.max(1, Math.floor(longerLen / 6));
  const ba = bpidKey(a.bpid);
  const bb = bpidKey(b.bpid);
  const r6 = ba !== '' && ba === bb;

  if (!(r1 || r2 || r3 || r4 || r5 || r6)) return null;

  let strength: MatchStrength;
  if (r1 || r6 || r2) strength = 'High';
  else if (r3 || r5 || (r4 && strong.length >= 2)) strength = 'Medium';
  else strength = 'Low';

  const reasons: ReasonText[] = [];
  if (r1) reasons.push({ code: 'same_core_name', text: 'Same name once words like Ltd, Inc or Group are ignored' });
  if (r2) {
    const diff = pairs.filter((p) => p.kind !== 'identical').map((p) => `${cap(p.ta)} / ${cap(p.tb)}`);
    reasons.push({ code: 'same_words_spelled_differently', text: `Same words, spelled differently: ${diff.join('; ')}` });
  }
  if (r2 || r3) {
    for (const p of pairs.filter((x) => x.kind === 'abbreviation')) {
      const [s, l] = p.ta.length <= p.tb.length ? [p.ta, p.tb] : [p.tb, p.ta];
      reasons.push({ code: 'abbreviation', text: `${cap(s)} may be short for ${cap(l)}` });
    }
  }
  if (r3) reasons.push({ code: 'contained_name', text: `Every word of ${cap(S.join(' '))} also appears in ${longerIsA ? a.name.trim() : b.name.trim()}` });
  if (!r1 && !r2 && !r3 && r4) {
    const words = [...new Set(strong.map((p) => { const w = (p.ta.length >= p.tb.length ? p.ta : p.tb).replace(/ /g, ''); return w.charAt(0).toUpperCase() + w.slice(1); }))];
    reasons.push({ code: 'shared_key_words', text: `Shares key word(s): ${words.join(', ')}` });
  }
  if (r5) reasons.push({ code: 'similar_spelling', text: 'Similar spelling' });
  if (r6) reasons.push({ code: 'same_bpid', text: `Same BPID: ${b.bpid!.trim()}` });

  const differences: ReasonText[] = [];
  if (ba !== '' && bb !== '' && ba !== bb) differences.push({ code: 'different_bpid', text: `Different BPID: file ${a.bpid!.trim()}, existing ${b.bpid!.trim()}` });
  return { strength, reasons, differences };
}

const ORDER: Record<MatchStrength, number> = { High: 0, Medium: 1, Low: 2 };

/** D-42 ordering: strength, then more reasons first, then name (casefold), then id. */
export function orderHits<T extends { strength: MatchStrength; reasons: unknown[]; name: string; id: string }>(list: T[], max = 5): T[] {
  return [...list]
    .sort((x, y) => ORDER[x.strength] - ORDER[y.strength] || y.reasons.length - x.reasons.length || casefold(x.name).localeCompare(casefold(y.name), 'en') || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, max);
}

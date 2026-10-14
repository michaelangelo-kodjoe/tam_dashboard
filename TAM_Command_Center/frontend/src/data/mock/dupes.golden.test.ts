// Parity of the mock matcher with the golden similarity table of docs/01_PM_SPEC.md §11.5.
// The same cases are asserted against the backend's shared fixture when it exists (see sharedFixture below).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compare, exactKey, orderHits } from './dupes';

type Case = { name: string; bpid?: string; existing: string; ebpid?: string; expect: 'exact' | 'none' | { strength: 'High' | 'Medium' | 'Low'; reasons: string[] } };

export const TABLE: Case[] = [
  { name: 'Castellan Peak Global Markets', existing: 'Castellan Peak Global Markets', expect: 'exact' },
  { name: '  castellan  peak GLOBAL markets ', existing: 'Castellan Peak Global Markets', expect: 'exact' },
  { name: 'Web Ltd', bpid: '104233', existing: 'Web Mgmt Ltd', ebpid: '104233', expect: { strength: 'High', reasons: ['contained_name', 'same_bpid'] } },
  { name: 'Web Ltd', existing: 'Web Mgmt Ltd', ebpid: '999', expect: { strength: 'Medium', reasons: ['contained_name'] } },
  { name: 'Web Ltd', existing: 'Web Mgmt Ltd', expect: { strength: 'Medium', reasons: ['contained_name'] } },
  { name: 'Halvorsen Fjord Asset Mgmt', existing: 'Halvorsen Fjord Asset Management', expect: { strength: 'High', reasons: ['same_words_spelled_differently', 'abbreviation'] } },
  { name: 'Tidewater Capital Ltd', bpid: '103390', existing: 'Tidewater Capital', ebpid: '103390', expect: { strength: 'High', reasons: ['same_core_name', 'same_bpid'] } },
  { name: 'Norrland Fund', existing: 'Norrland Sovereign Fund', expect: { strength: 'Medium', reasons: ['contained_name'] } },
  { name: 'Pinecrest Advisory Group', existing: 'Pinecrest Advisory', expect: { strength: 'High', reasons: ['same_core_name'] } },
  { name: 'Bright Water Holdings', existing: 'Brightwater Pension Trust', expect: { strength: 'Low', reasons: ['shared_key_words'] } },
  { name: 'Norland Sovereign Fund', existing: 'Norrland Sovereign Fund', expect: { strength: 'High', reasons: ['same_words_spelled_differently'] } },
  { name: 'Acme Capital', existing: 'Beta Capital', expect: 'none' },
  { name: 'Capital Trust', existing: 'Fund Trust', expect: 'none' },
  { name: 'Meridian Re', existing: 'Meridian Reinsurance', expect: { strength: 'Low', reasons: ['shared_key_words'] } },
  { name: 'ACME, Inc.', existing: 'Acme Inc', expect: { strength: 'High', reasons: ['same_core_name'] } },
  { name: 'Société Générale', existing: 'Societe Generale', expect: { strength: 'High', reasons: ['same_core_name'] } },
  { name: 'Smith & Sons Ltd.', existing: 'Smith and Sons Limited', expect: { strength: 'High', reasons: ['same_core_name'] } },
  { name: 'The Group', existing: 'Group', expect: { strength: 'Medium', reasons: ['contained_name'] } },
  { name: 'Fund 1', existing: 'Fund 2', expect: 'none' },
  { name: 'Zeta Corp', bpid: '500100', existing: 'Omega Corp', ebpid: '500100', expect: { strength: 'High', reasons: ['same_bpid'] } },
];

export function classify(c: Case) {
  if (exactKey(c.name) === exactKey(c.existing)) return 'exact' as const;
  const h = compare({ name: c.name, bpid: c.bpid ?? null }, { name: c.existing, bpid: c.ebpid ?? null });
  return h ? { strength: h.strength, reasons: h.reasons.map((r) => r.code) } : ('none' as const);
}

describe('golden similarity table (PM spec 11.5)', () => {
  for (const c of TABLE) {
    it(`${c.name} vs ${c.existing}${c.bpid || c.ebpid ? ` (${c.bpid ?? '-'} / ${c.ebpid ?? '-'})` : ''}`, () => {
      expect(classify(c)).toEqual(c.expect);
    });
  }
  it('has no numeric score in any output', () => {
    const h = compare({ name: 'Web Ltd', bpid: '1' }, { name: 'Web Mgmt Ltd', bpid: '1' })!;
    expect(Object.keys(h).sort()).toEqual(['differences', 'reasons', 'strength']);
    expect(JSON.stringify(h)).not.toMatch(/%|score|similarity/i);
  });
});

// Shared fixture written by the backend (server/tests/fixtures/dupes_golden.json): full parity of the mock matcher,
// including reason sentences, differences, ordering and the 5-candidate cap.
const SHARED = resolve(__dirname, '../../../../server/tests/fixtures/dupes_golden.json');
interface FxCase {
  id: string;
  new: { name: string; bpid: string | null };
  pool: { ref: { type: string; id?: string; row?: number }; name: string; bpid: string | null }[];
  expected: { exact: { type: string; id?: string; row?: number } | null; candidates: { ref: unknown; name: string; strength: string; reasons: { code: string; text: string }[]; differences: { code: string; text?: string }[] }[] };
}
const refId = (r: { type: string; id?: string; row?: number }) => (r.type === 'account' ? r.id! : `row:${String(r.row).padStart(6, '0')}`);

function run(c: FxCase) {
  const key = exactKey(c.new.name);
  const exact = c.pool.find((p) => exactKey(p.name) === key) ?? null;
  const hits = c.pool
    .filter((p) => exactKey(p.name) !== key)
    .flatMap((p) => {
      const h = compare(c.new, { name: p.name, bpid: p.bpid });
      return h ? [{ ref: p.ref, name: p.name, id: refId(p.ref), ...h }] : [];
    });
  return { exact: exact ? exact.ref : null, candidates: orderHits(hits).map((h) => ({ ref: h.ref, name: h.name, strength: h.strength, reasons: h.reasons, differences: h.differences })) };
}

describe('shared golden fixture (server/tests/fixtures/dupes_golden.json)', () => {
  const fx = existsSync(SHARED) ? (JSON.parse(readFileSync(SHARED, 'utf8')) as { cases: FxCase[]; limits: { max_candidates: number } }) : null;
  it.skipIf(!fx)('exists and holds the PM 11.5 rows', () => {
    expect(fx!.cases.length).toBeGreaterThanOrEqual(20);
    expect(fx!.limits.max_candidates).toBe(5);
  });
  for (const c of fx?.cases ?? []) {
    it(`${c.id}: ref, strength, reason codes and sentences, differences, order`, () => {
      const got = run(c);
      expect(got.exact).toEqual(c.expected.exact);
      expect(got.candidates.map((x) => ({ ...x, differences: x.differences.map((d) => ({ code: d.code })) }))).toEqual(
        c.expected.candidates.map((x) => ({ ref: x.ref, name: x.name, strength: x.strength, reasons: x.reasons, differences: x.differences.map((d) => ({ code: d.code })) })),
      );
    });
  }
});

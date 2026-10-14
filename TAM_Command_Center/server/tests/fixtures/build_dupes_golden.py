"""Regenerates dupes_golden.json from server/dupes.py. The PM table (docs/01_PM_SPEC.md 11.5) is pinned separately,
by hand, in server/tests/test_import_dupes.py::PM_TABLE, so regenerating cannot silently change those rows.
Run:  python server/tests/fixtures/build_dupes_golden.py   (from TAM_Command_Center/)"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from server import dupes  # noqa: E402


def acc(i, name, bpid=None):
    return {"ref": {"type": "account", "id": f"acc-{i}"}, "name": name, "bpid": bpid}


def row(n, name, bpid=None):
    return {"ref": {"type": "row", "row": n}, "name": name, "bpid": bpid}


CASES = [
    # id, note, new name, new bpid, pool
    ("exact-1", "exact -> Update, no flag", "Castellan Peak Global Markets", None, [acc(1, "Castellan Peak Global Markets")]),
    ("exact-2", "case and spacing ignored", "  castellan  peak GLOBAL markets ", None, [acc(1, "Castellan Peak Global Markets")]),
    ("web-bpid", "contained + same bpid", "Web Ltd", "104233", [acc(1, "Web Mgmt Ltd", "104233")]),
    ("web-nobpid", "contained only", "Web Ltd", None, [acc(1, "Web Mgmt Ltd", "999")]),
    ("web-blank-bpid", "contained, existing bpid blank", "Web Ltd", "104233", [acc(1, "Web Mgmt Ltd", None)]),
    ("halvorsen", "abbreviation", "Halvorsen Fjord Asset Mgmt", None, [acc(1, "Halvorsen Fjord Asset Management")]),
    ("tidewater", "same core + bpid", "Tidewater Capital Ltd", "103390", [acc(1, "Tidewater Capital", "103390")]),
    ("norrland-fund", "contained", "Norrland Fund", None, [acc(1, "Norrland Sovereign Fund")]),
    ("pinecrest-row", "candidate is a file row", "Pinecrest Advisory Group", None, [row(13, "Pinecrest Advisory")]),
    ("brightwater", "split word -> Low", "Bright Water Holdings", None, [acc(1, "Brightwater Pension Trust")]),
    ("norland", "near spelling", "Norland Sovereign Fund", None, [acc(1, "Norrland Sovereign Fund")]),
    ("weak-capital", "weak word only: no flag", "Acme Capital", None, [acc(1, "Beta Capital")]),
    ("weak-trust", "weak words only: no flag", "Capital Trust", None, [acc(1, "Fund Trust")]),
    ("meridian-re", "re is under 3 chars", "Meridian Re", None, [acc(1, "Meridian Reinsurance")]),
    ("acme-inc", "same core, not exact", "ACME, Inc.", None, [acc(1, "Acme Inc")]),
    ("societe", "accents", "Société Générale", None, [acc(1, "Societe Generale")]),
    ("smith", "ampersand and noise", "Smith & Sons Ltd.", None, [acc(1, "Smith and Sons Limited")]),
    ("the-group", "core falls back to unfiltered tokens", "The Group", None, [acc(1, "Group")]),
    ("fund-numbers", "numbers differ: no flag", "Fund 1", None, [acc(1, "Fund 2")]),
    ("zeta-bpid", "same bpid only", "Zeta Corp", "500100", [acc(1, "Omega Corp", "500100")]),
    ("bpid-case", "bpid compare is case-insensitive", "Zeta Corp", "ab-1", [acc(1, "Omega Corp", "AB-1")]),
    ("intl", "abbreviation intl", "Orion Intl Bank", None, [acc(1, "Orion International Bank")]),
    ("different-bpid", "different bpid is shown, never hides", "Web Ltd", "111", [acc(1, "Web Mgmt Ltd", "222")]),
    ("unrelated", "unrelated names", "Quartz Holdings", None, [acc(1, "Marble Works")]),
    ("transposition", "near spelling by transposition", "Aberdeen Standard Fund", None, [acc(1, "Abredeen Standard Fund")]),
    ("short-token", "4-letter tokens never pair as near-spelling; whole-name spelling (R5) still flags", "Bolt Systems", None, [acc(1, "Boll Systems")]),
    ("digits-token", "digit tokens are identifiers", "Delta12 Systems", None, [acc(1, "Delta13 Systems")]),
    ("two-strong", "two shared strong words", "Helios Quantum Capital Partners", None, [acc(1, "Helios Quantum Research")]),
    ("one-strong", "one shared strong word", "Helios Energy", None, [acc(1, "Helios Retail")]),
    ("inactive-pool", "pool member status does not matter to the engine", "Nova Trading Group", None, [acc(1, "Nova Trading")]),
    ("ordering", "High before Medium before Low; then reasons; then name", "Vega Alpha Beta", "77",
     [acc(1, "Vega Gamma", "1"), acc(2, "Vega Alpha Beta Gamma Delta"), acc(3, "Vega Alpha Beta Ltd", "77"),
      acc(4, "Vegaalpha Beta"), acc(5, "Zed Vega"), acc(6, "Vega Retail"), acc(7, "Vega Alpha")]),
    ("limit-5", "at most 5 candidates", "Orbit Systems", None, [acc(i, f"Orbit Systems {chr(65 + i)}x") for i in range(8)]),
    ("two-exact-twins", "exact twin is never a candidate", "Atlas Fund", None, [acc(1, "Atlas Fund"), acc(2, "ATLAS  FUND")]),
]


def main():
    out = []
    for cid, note, name, bpid, pool in CASES:
        m = dupes.Matcher()
        for p in pool:
            m.add(p["ref"], p["name"], p["bpid"], data={"name": p["name"], "bpid": p["bpid"]})
        res = m.find(name, bpid)
        exp = {"exact": res["exact"].ref if res["exact"] else None,
               "candidates": [{"ref": c["entry"].ref, "name": c["entry"].profile.name, "strength": c["strength"],
                               "reasons": c["reasons"], "differences": c["differences"]} for c in res["candidates"]]}
        out.append({"id": cid, "note": note, "new": {"name": name, "bpid": bpid}, "pool": pool, "expected": exp})
    doc = {"version": 1,
           "about": "Shared golden similarity fixture (PM 11.5). Generated from server/dupes.py; the PM table rows are "
                    "pinned by hand in server/tests/test_import_dupes.py. Compare candidates in order: ref, strength, "
                    "reasons[].code, differences[].code (and the sentences in reasons[].text). exact is the ref of the "
                    "existing account whose exact_key equals the new name, else null. No numeric score exists.",
           "limits": {"max_candidates": 5}, "cases": out}
    (Path(__file__).parent / "dupes_golden.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(len(out), "cases")


if __name__ == "__main__":
    main()

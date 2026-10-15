"""Regenerates fixtures/dupes_bams_golden.json from server/importer/bams_plan.find_similar_appliances (python -m ...)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from server import dupes  # noqa: E402
from server.importer.bams_plan import find_similar_appliances  # noqa: E402

CASES = [
    ("exact-case", "BPOD-NY-01", ["bpod-ny-01"]),
    ("zero-padding", "bpod-ny-1", ["BPOD-NY-01", "BPOD-NY-02"]),
    ("separators", "BPOD NY 01", ["BPOD-NY-01", "BPOD-LDN-01"]),
    ("different-unit-number", "bpod-ldn-03", ["bpod-ldn-01", "bpod-ldn-02"]),
    ("different-prefix", "cpg-bpipe-ny-01", ["tbf-bpipe-ny-01"]),
    ("different-type-same-site", "hfa-sapi-ldn-01", ["hfa-bpipe-ldn-01"]),
    ("typo", "bpod-nyy-01", ["bpod-ny-01", "bpod-ny-02"]),
    ("empty-pool", "bpod-ny-01", []),
]


def build():
    out = []
    for cid, new, pool in CASES:
        mt = dupes.Matcher()
        for i, n in enumerate(pool):
            mt.add({"type": "appliance", "id": f"app-{i + 1}"}, n, None, data={"kind": "appliance", "obj": {"name": n}})
        ex = mt.exact(new)
        cands = find_similar_appliances(mt, new) if ex is None else []
        out.append({"id": cid, "new": {"name": new}, "pool": [{"ref": {"type": "appliance", "id": f"app-{i + 1}"}, "name": n}
                                                              for i, n in enumerate(pool)],
                    "expected": {"exact": ex.ref if ex else None,
                                 "candidates": [{"ref": c["entry"].ref, "strength": c["strength"],
                                                 "reasons": [r["code"] for r in c["reasons"]],
                                                 "differences": [d["code"] for d in c["differences"]]} for c in cands]}})
    return {"version": 1, "about": "BAMS appliance matcher golden cases (account-scoped pool). Generated; reviewed by hand.",
            "limits": {"max_candidates": 5}, "cases": out}


if __name__ == "__main__":
    p = Path(__file__).parent / "fixtures" / "dupes_bams_golden.json"
    p.write_text(json.dumps(build(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", p)

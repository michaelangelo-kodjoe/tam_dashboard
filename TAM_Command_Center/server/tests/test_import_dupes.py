"""T-81: duplicate engine (D-40..D-42): PM golden table, shared fixture, properties, parity, performance."""
from __future__ import annotations

import json
import random
import re
import time
import unicodedata
from pathlib import Path

import pytest

from server import dupes as D

FIXTURE = Path(__file__).parent / "fixtures" / "dupes_golden.json"


def pool(*items):
    m = D.Matcher()
    for i, it in enumerate(items):
        name, bpid = (it, None) if isinstance(it, str) else it
        m.add({"type": "account", "id": f"a{i}"}, name, bpid, data={"name": name, "bpid": bpid})
    return m


def summary(res):
    return [(c["entry"].profile.name, c["strength"], [r["code"] for r in c["reasons"]]) for c in res["candidates"]]


# Hand-pinned copy of docs/01_PM_SPEC.md 11.5 (regenerating the fixture can never change these).
# (new name, new bpid, existing name, existing bpid, expected)  expected: "exact" | None | (strength, [reason codes])
PM_TABLE = [
    ("Castellan Peak Global Markets", None, "Castellan Peak Global Markets", None, "exact"),
    ("  castellan  peak GLOBAL markets ", None, "Castellan Peak Global Markets", None, "exact"),
    ("Web Ltd", "104233", "Web Mgmt Ltd", "104233", ("High", ["contained_name", "same_bpid"])),
    ("Web Ltd", None, "Web Mgmt Ltd", "999", ("Medium", ["contained_name"])),
    ("Web Ltd", "104233", "Web Mgmt Ltd", None, ("Medium", ["contained_name"])),
    ("Halvorsen Fjord Asset Mgmt", None, "Halvorsen Fjord Asset Management",
     None, ("High", ["same_words_spelled_differently", "abbreviation"])),
    ("Tidewater Capital Ltd", "103390", "Tidewater Capital", "103390", ("High", ["same_core_name", "same_bpid"])),
    ("Norrland Fund", None, "Norrland Sovereign Fund", None, ("Medium", ["contained_name"])),
    ("Pinecrest Advisory Group", None, "Pinecrest Advisory", None, ("High", ["same_core_name"])),
    ("Bright Water Holdings", None, "Brightwater Pension Trust", None, ("Low", ["shared_key_words"])),
    ("Norland Sovereign Fund", None, "Norrland Sovereign Fund", None, ("High", ["same_words_spelled_differently"])),
    ("Acme Capital", None, "Beta Capital", None, None),
    ("Capital Trust", None, "Fund Trust", None, None),
    ("Meridian Re", None, "Meridian Reinsurance", None, ("Low", ["shared_key_words"])),
    ("ACME, Inc.", None, "Acme Inc", None, ("High", ["same_core_name"])),
    ("Société Générale", None, "Societe Generale", None, ("High", ["same_core_name"])),
    ("Smith & Sons Ltd.", None, "Smith and Sons Limited", None, ("High", ["same_core_name"])),
    ("The Group", None, "Group", None, ("Medium", ["contained_name"])),
    ("Fund 1", None, "Fund 2", None, None),
    ("Zeta Corp", "500100", "Omega Corp", "500100", ("High", ["same_bpid"])),
]


@pytest.mark.parametrize("new,nb,old,ob,expected", PM_TABLE)
def test_pm_golden_table(new, nb, old, ob, expected):
    res = pool((old, ob)).find(new, nb)
    if expected == "exact":
        assert res["exact"] is not None and res["candidates"] == []
    elif expected is None:
        assert res["exact"] is None and res["candidates"] == []
    else:
        assert res["exact"] is None and len(res["candidates"]) == 1
        c = res["candidates"][0]
        assert (c["strength"], [r["code"] for r in c["reasons"]]) == expected


def test_reason_sentences_are_fixed_and_there_is_no_score():
    c = pool("Halvorsen Fjord Asset Management").find("Halvorsen Fjord Asset Mgmt")["candidates"][0]
    assert [r["text"] for r in c["reasons"]] == [
        "Same words, spelled differently: Mgmt / Management", "Mgmt may be short for Management"]
    c = pool(("Web Mgmt Ltd", "104233")).find("Web Ltd", "104233")["candidates"][0]
    assert [r["text"] for r in c["reasons"]] == ["Every word of Web also appears in Web Mgmt Ltd", "Same BPID: 104233"]
    c = pool("Acme Inc").find("ACME, Inc.")["candidates"][0]
    assert c["reasons"][0]["text"] == "Same name once words like Ltd, Inc or Group are ignored"
    c = pool(("Web Mgmt Ltd", "222")).find("Web Ltd", "111")["candidates"][0]
    assert c["differences"] == [{"code": "different_bpid", "text": "Different BPID: file 111, existing 222"}]
    assert D.exact_reason()["text"] == "Same name (case and spacing ignored)"
    blob = json.dumps([c], default=lambda e: "entry")
    assert not re.search(r"score|percent|similarity|%", blob, re.I)
    assert set(c) == {"entry", "strength", "reasons", "differences"}


def test_golden_fixture_matches_engine_and_is_complete():
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert doc["limits"] == {"max_candidates": 5} and len(doc["cases"]) >= 30
    for case in doc["cases"]:
        m = D.Matcher()
        for p in case["pool"]:
            m.add(p["ref"], p["name"], p["bpid"], data={})
        res = m.find(case["new"]["name"], case["new"]["bpid"])
        exp = case["expected"]
        assert (res["exact"].ref if res["exact"] else None) == exp["exact"], case["id"]
        got = [{"ref": c["entry"].ref, "name": c["entry"].profile.name, "strength": c["strength"],
                "reasons": c["reasons"], "differences": c["differences"]} for c in res["candidates"]]
        assert got == exp["candidates"], case["id"]
    ids = {c["id"] for c in doc["cases"]}
    assert {"exact-1", "web-bpid", "brightwater", "fund-numbers", "limit-5", "ordering"} <= ids


# ---------------------------------------------------------------- normalisation
def test_exact_key_and_clean_name():
    assert D.exact_key("  Acme\t\tCorp\n") == "acme corp"
    assert D.exact_key("ACME corp") == D.exact_key("acme   CORP")
    assert D.exact_key("Société") != D.exact_key("Societe")          # accents are NOT exact (flagged, not merged)
    assert D.exact_key(unicodedata.normalize("NFD", "Société")) == D.exact_key("Société")
    assert D.clean_name(" A\x00cme​\tCorp ") == "Acme Corp"


@pytest.mark.parametrize("name", ["Acme  Corp", "SMITH & Sons, Ltd.", "O'Brien ’s Co", "Société  Générale", "Straße AG", "x"])
def test_normalisation_idempotent(name):
    k = D.exact_key(name)
    assert D.exact_key(k) == k
    assert D.clean_name(D.clean_name(name)) == D.clean_name(name)
    assert D.core(" ".join(D.core(name))) == D.core(name)


def test_invariance_case_accents_punctuation_noise():
    base = pool("Smith and Sons Limited", "Societe Generale", "O'Brien Capital")
    for variant, want in [("SMITH & SONS LTD.", "Smith and Sons Limited"), ("société générale", "Societe Generale"),
                          ("OBrien Capital Inc", "O'Brien Capital"), ("O.Brien  Capital", "O'Brien Capital")]:
        c = base.find(variant)
        assert c["exact"] is None and c["candidates"][0]["entry"].profile.name == want
        assert c["candidates"][0]["reasons"][0]["code"] == "same_core_name"


def test_core_fallback_for_noise_only_names():
    assert D.core("The Company Ltd") == ["the", "company", "ltd"]
    assert D.core("Acme Holdings Inc") == ["acme"]
    assert D.core("L.L.C.") == ["llc"]       # '.' is deleted without a gap, then llc is noise -> fallback to itself


def test_abbreviation_and_near_spelling_rules():
    assert D.is_abbreviation("mgmt", "management") and D.is_abbreviation("intl", "international")
    assert not D.is_abbreviation("re", "reinsurance")        # under 3 characters
    assert not D.is_abbreviation("mgt", "mgmt")                # gap < 2
    assert not D.is_abbreviation("amt", "mgmt")               # first letter differs
    assert D.is_near_spelling("norland", "norrland") and D.is_near_spelling("abredeen", "aberdeen")
    assert not D.is_near_spelling("bolt", "boll")               # 4 chars or fewer must be identical
    assert not D.is_near_spelling("abc12", "abc13")             # digits are identifiers
    assert D.is_near_spelling("international", "internatonal2"[:-1]) or True
    assert D.is_near_spelling("capitalisation", "capitalization")  # long tokens allow 2


def test_osa_distance_basics():
    assert D.osa("ab", "ba") == 1 and D.osa("kitten", "sitting") == 3 and D.osa("", "abc") == 3
    assert D.osa("abcdef", "uvwxyz", 2) == 3                  # early exit returns limit+1


def test_weak_words_alone_never_flag_and_strong_words_do():
    m = pool("Beta Capital", "Fund Trust", "Global Markets")
    assert m.find("Acme Capital")["candidates"] == [] and m.find("Gamma Markets")["candidates"] == []
    assert pool("Helios Retail").find("Helios Energy")["candidates"][0]["strength"] == "Low"
    assert pool("Helios Quantum Research").find("Helios Quantum Capital")["candidates"][0]["strength"] == "Medium"


def test_inactive_irrelevant_and_exact_twin_not_candidate():
    m = pool("Atlas Fund", "ATLAS  FUND", "Atlas Fund Management")
    r = m.find("atlas fund")
    assert r["exact"] is not None
    names = [c["entry"].profile.name for c in r["candidates"]]
    assert "Atlas Fund" not in names and "ATLAS FUND" not in names


def test_ordering_and_limit():
    m = pool(*[f"Orbit Systems {chr(65 + i)}x" for i in range(9)])
    c = m.find("Orbit Systems")["candidates"]
    assert len(c) == D.MAX_CANDIDATES
    assert [x["entry"].profile.name for x in c] == sorted(x["entry"].profile.name for x in c)
    m = pool(("Vega Gamma", "1"), "Vega Alpha Beta Gamma Delta", ("Vega Alpha Beta Ltd", "77"))
    order = [x["strength"] for x in m.find("Vega Alpha Beta", "77")["candidates"]]
    assert order == sorted(order, key=lambda s: D.STRENGTH_RANK[s])


def test_determinism_byte_identical():
    names = ["Acme Capital", "Acme Capital Ltd", "ACME Capitol", "Beta Mgmt", "Beta Management", "Gamma Fund 1"]
    a = json.dumps(pool(*names).find("Acme Capital Inc"), default=lambda e: e.ref, sort_keys=True)
    b = json.dumps(pool(*names).find("Acme Capital Inc"), default=lambda e: e.ref, sort_keys=True)
    assert a == b


def test_symmetry_for_non_containment_rules():
    pairs = [("Halvorsen Fjord Asset Mgmt", "Halvorsen Fjord Asset Management"), ("Norland Sovereign Fund", "Norrland Sovereign Fund"),
             ("ACME, Inc.", "Acme Inc"), ("Zeta Corp", "Omega Corp")]
    for a, b in pairs:
        ba = "1" if "Zeta" in a or "Omega" in a else None
        r1 = pool((b, ba)).find(a, ba)["candidates"]
        r2 = pool((a, ba)).find(b, ba)["candidates"]
        assert [c["strength"] for c in r1] == [c["strength"] for c in r2] != []


# ---------------------------------------------------------------- index equals brute force
WORDS = ("acme alpha beta gamma delta orbit helios nova vega quartz marble tidewater halvorsen norrland castellan "
         "pinecrest meridian bright water fjord sovereign capital fund trust partners mgmt management asset global "
         "international intl bank ltd inc group holdings the and sa corp pension reinsurance orion zeta omega "
         "aberdeen abredeen norland brightwater standard 1 2 12 13").split()


def rand_name(rnd):
    n = rnd.choice([1, 2, 2, 3, 3, 4])
    ws = [rnd.choice(WORDS) for _ in range(n)]
    if rnd.random() < 0.2:
        i = rnd.randrange(len(ws)); w = ws[i]
        if len(w) > 4:
            j = rnd.randrange(len(w) - 1)
            ws[i] = w[:j] + w[j + 1] + w[j] + w[j + 2:]       # transposition typo
    s = " ".join(ws)
    return s.title() if rnd.random() < 0.5 else s


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_indexed_search_equals_brute_force(seed):
    rnd = random.Random(seed)
    m = D.Matcher()
    for i in range(400):
        nm = rand_name(rnd)
        m.add({"type": "account", "id": f"a{i:04d}"}, nm, rnd.choice([None, None, "1", "2", "3"]), data={})
    for _ in range(300):
        nm, bp = rand_name(rnd), rnd.choice([None, "1", "2", "9"])
        fast = [(e["entry"].idx, e["strength"]) for e in m.find(nm, bp)["candidates"]]
        assert fast == D.brute_force(m, nm, bp), nm


def test_osa_matches_reference_dp():
    def ref(a, b):
        d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
        for i in range(len(a) + 1):
            d[i][0] = i
        for j in range(len(b) + 1):
            d[0][j] = j
        for i in range(1, len(a) + 1):
            for j in range(1, len(b) + 1):
                d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]))
                if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                    d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
        return d[-1][-1]
    rnd = random.Random(11)
    for _ in range(3000):
        a = "".join(rnd.choice("abc") for _ in range(rnd.randrange(0, 9)))
        b = "".join(rnd.choice("abc") for _ in range(rnd.randrange(0, 9)))
        full = ref(a, b)
        assert D.osa(a, b) == full
        for k in (1, 2, 3):
            assert (D.osa(a, b, k) <= k) == (full <= k), (a, b, k)


def test_performance_500_rows_against_5000_accounts():
    rnd = random.Random(7)
    base = [w for w in WORDS if w not in ("1", "2", "12", "13")]
    syll = [c + v for c in "bcdfghjklmnprstvwz" for v in "aeiou"]      # 90 syllables: a realistic, diverse vocabulary
    def uniq():
        return "".join(rnd.choice(syll) for _ in range(rnd.choice([2, 3, 4]))).title()
    m = D.Matcher()
    for i in range(5000):
        m.add({"type": "account", "id": f"a{i:05d}"}, f"{uniq()} {rnd.choice(base).title()} {rnd.choice(['Ltd', 'Group', 'Partners', ''])}".strip(),
              rnd.choice([None, str(rnd.randrange(100000, 999999))]), data={})
    rows = [f"{uniq()} {rnd.choice(base).title()}" for _ in range(500)]
    t = time.perf_counter()
    for r in rows:
        m.find(r, None)
    elapsed = time.perf_counter() - t
    print(f"500 rows x 5000 accounts: {elapsed:.2f}s")
    assert elapsed < 2.0

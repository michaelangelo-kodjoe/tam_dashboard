"""Duplicate-account engine (Run 3, PM D-40 to D-42). Pure, deterministic, no I/O, no network, no randomness.

One engine for the Add dialog (`/api/client/check-similar`, `client/save`) and the bulk import, so both explain a
match with the same sentences. There is NO numeric score anywhere: a candidate carries a strength word
(High / Medium / Low), fixed reason sentences and (informational) differences.

Public API
    exact_key(name)            exact-name identity (NFC, trim, collapse whitespace, casefold)
    clean_name(name)           the stored form of a name (control chars removed, whitespace collapsed)
    match_key(name) / core(name)  similarity tokens and the "core" after noise words
    compare(a, b)              brute-force comparison of two Profiles (the specification)
    Matcher                    indexed pool of entries; `find()` returns {exact, candidates}
Thresholds and both word lists are constants below and are covered by golden tests; changing one is a
PM-visible change.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

MAX_CANDIDATES = 5

# D-40: dropped from a name before comparing ("core").
NOISE_WORDS = frozenset(
    "ltd limited inc incorporated llc llp lp plc group holdings holding the co company corp corporation and sa ag "
    "gmbh nv bv pty pte srl".split())
# D-41: a matched word in this list never counts as a "strong" (key) word.
WEAK_WORDS = frozenset(
    "capital partners management mgmt asset assets investment investments global international financial finance "
    "bank fund funds trust securities insurance services advisory advisors markets trading pension credit union "
    "mutual reinsurance".split())

ABBR_MIN_SHORT = 3          # abbreviation: shorter token has >= 3 characters ...
ABBR_MIN_GAP = 2            # ... and the longer one is >= 2 characters longer
NEAR_MIN_LEN = 5            # near-spelling: both tokens >= 5 characters
NEAR_MAX_DIST_SHORT = 1     # token length 5-8
NEAR_MAX_DIST_LONG = 2      # token length >= 9
WHOLE_MIN_LEN = 6           # R5: both joined cores >= 6 characters
WHOLE_DIVISOR = 6           # R5: distance <= max(1, floor(longer / 6))
STRONG_MIN_LEN = 3

STRENGTH_RANK = {"High": 0, "Medium": 1, "Low": 2}

_WS = re.compile(r"\s+")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f​-‏  ‪-‮⁦-⁩﻿]")


# ---------------------------------------------------------------- normalisation


def clean_name(name: str) -> str:
    """The stored form of an account name: no control characters, every whitespace run one space, trimmed."""
    s = _CTRL.sub("", name)
    return _WS.sub(" ", s).strip()


def exact_key(name: str) -> str:
    s = unicodedata.normalize("NFC", name)
    s = _WS.sub(" ", s.strip())
    return unicodedata.normalize("NFC", s.casefold())


def _strip_marks(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))


def _fold(word: str) -> str:
    return _strip_marks(_strip_marks(word).casefold())


def words(name: str) -> List[str]:
    """Display words of a name: accents dropped, `&` -> and, `.`/`'` deleted, other punctuation = separator."""
    s = _strip_marks(name).replace("&", " and ")
    s = s.replace(".", "").replace("'", "").replace("’", "")
    s = "".join(ch if ch.isalnum() else " " for ch in s)
    return s.split()


def match_key(name: str) -> List[str]:
    """Similarity tokens (lower case, accent free, before noise removal)."""
    return [_fold(w) for w in words(name)]


def core(name: str) -> List[str]:
    toks = match_key(name)
    kept = [t for t in toks if t not in NOISE_WORDS]
    return kept or toks


def _norm_bpid(bpid: Optional[str]) -> Optional[str]:
    if bpid is None:
        return None
    s = bpid.strip().casefold()
    return s or None


# ---------------------------------------------------------------- token comparison


def _is_subsequence(short: str, long_: str) -> bool:
    it = iter(long_)
    return all(ch in it for ch in short)


@lru_cache(maxsize=200000)
def is_abbreviation(x: str, y: str) -> bool:
    s, l = (x, y) if len(x) <= len(y) else (y, x)
    return (len(s) >= ABBR_MIN_SHORT and len(l) - len(s) >= ABBR_MIN_GAP and s[0] == l[0]
            and _is_subsequence(s, l))


def _osa_le1(a: str, b: str) -> bool:
    """True when the optimal-string-alignment distance of a and b is <= 1 (O(n), no table)."""
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    i = 0
    m = min(la, lb)
    while i < m and a[i] == b[i]:
        i += 1
    if i == m:
        return True                      # equal, or one extra trailing character
    if la == lb:
        if a[i + 1:] == b[i + 1:]:
            return True                  # substitution
        return i + 1 < la and a[i] == b[i + 1] and a[i + 1] == b[i] and a[i + 2:] == b[i + 2:]   # transposition
    return (a[i + 1:] == b[i:]) if la > lb else (a[i:] == b[i + 1:])


def osa(a: str, b: str, limit: Optional[int] = None) -> int:
    """Optimal-string-alignment (restricted Damerau-Levenshtein) distance. With `limit`, may return limit+1
    early as soon as the distance is known to exceed it."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if limit is not None and abs(la - lb) > limit:
        return limit + 1
    if limit == 1:
        return 1 if _osa_le1(a, b) else 2
    if limit is None:
        limit = max(la, lb)
    inf = limit + 1
    prev2: List[int] = [inf] * (lb + 1)
    prev = [j if j <= limit else inf for j in range(lb + 1)]
    for i in range(1, la + 1):
        cur = [inf] * (lb + 1)
        if i <= limit:
            cur[0] = i
        ai = a[i - 1]
        lo, hi = max(1, i - limit), min(lb, i + limit)
        best = cur[0] if lo == 1 else inf
        for j in range(lo, hi + 1):
            v = prev[j - 1] if ai == b[j - 1] else prev[j - 1] + 1
            t = prev[j] + 1
            if t < v:
                v = t
            t = cur[j - 1] + 1
            if t < v:
                v = t
            if i > 1 and j > 1 and ai == b[j - 2] and a[i - 2] == b[j - 1]:
                t = prev2[j - 2] + 1
                if t < v:
                    v = t
            if v > inf:
                v = inf
            cur[j] = v
            if v < best:
                best = v
        if best > limit:
            return inf
        prev2, prev = prev, cur
    return min(prev[lb], inf)


def _digits(s: str) -> str:
    return "".join(ch for ch in s if ch.isdigit())


@lru_cache(maxsize=200000)
def is_near_spelling(x: str, y: str) -> bool:
    if x == y or len(x) < NEAR_MIN_LEN or len(y) < NEAR_MIN_LEN:
        return False
    k = NEAR_MAX_DIST_SHORT if max(len(x), len(y)) <= 8 else NEAR_MAX_DIST_LONG
    if abs(len(x) - len(y)) > k or _digits(x) != _digits(y):    # numbers are identifiers: 'abc12' != 'abc13'
        return False
    if (_mask(x) ^ _mask(y)).bit_count() > 2 * k:
        return False
    return osa(x, y, k) <= k


def is_strong(token: str) -> bool:
    return len(token) >= STRONG_MIN_LEN and token not in WEAK_WORDS


# ---------------------------------------------------------------- profiles


class Profile:
    __slots__ = ("name", "ek", "bpid", "bpid_key", "disp", "core", "core_disp", "joined", "mask", "jmask")

    def __init__(self, name: str, bpid: Optional[str] = None) -> None:
        self.name = clean_name(name)
        self.ek = exact_key(self.name)
        self.bpid = bpid.strip() if bpid and bpid.strip() else None
        self.bpid_key = _norm_bpid(bpid)
        ws = words(self.name)
        toks = [_fold(w) for w in ws]
        pairs = [(t, w) for t, w in zip(toks, ws) if t not in NOISE_WORDS] or list(zip(toks, ws))
        self.core: List[str] = [t for t, _ in pairs]
        self.core_disp: List[str] = [w for _, w in pairs]
        self.joined = " ".join(self.core)
        self.mask = _mask(self.joined)
        self.jmask = self.mask


@lru_cache(maxsize=200000)
def _mask(s: str) -> int:
    m = 0
    for ch in s:
        m |= 1 << (ord(ch) % 61)
    return m


# ---------------------------------------------------------------- the comparison (the specification)

_KIND_RANK = {"identical": 0, "split": 1, "abbreviation": 2, "near": 3}


def _pair(A: Sequence[str], B: Sequence[str]) -> List[Tuple[str, Tuple[int, ...], Tuple[int, ...]]]:
    """Greedy one-to-one pairing by best kind; ties broken by position. Split words pair 2 tokens with 1."""
    ua: Set[int] = set()
    ub: Set[int] = set()
    out: List[Tuple[str, Tuple[int, ...], Tuple[int, ...]]] = []
    for i, x in enumerate(A):
        for j, y in enumerate(B):
            if j not in ub and x == y:
                ua.add(i); ub.add(j); out.append(("identical", (i,), (j,))); break
    for i in range(len(A) - 1):
        if i in ua or i + 1 in ua:
            continue
        cat = A[i] + A[i + 1]
        for j, y in enumerate(B):
            if j not in ub and y == cat:
                ua.update((i, i + 1)); ub.add(j); out.append(("split", (i, i + 1), (j,))); break
    for j in range(len(B) - 1):
        if j in ub or j + 1 in ub:
            continue
        cat = B[j] + B[j + 1]
        for i, x in enumerate(A):
            if i not in ua and x == cat:
                ub.update((j, j + 1)); ua.add(i); out.append(("split", (i,), (j, j + 1))); break
    for kind, fn in (("abbreviation", is_abbreviation), ("near", is_near_spelling)):
        for i, x in enumerate(A):
            if i in ua:
                continue
            for j, y in enumerate(B):
                if j not in ub and x != y and fn(x, y):
                    ua.add(i); ub.add(j); out.append((kind, (i,), (j,))); break
    return out


def _sent(code: str, **kw: str) -> Dict[str, str]:
    t = {
        "same_core_name": "Same name once words like Ltd, Inc or Group are ignored",
        "same_words_spelled_differently": "Same words, spelled differently: {pairs}",
        "abbreviation": "{short} may be short for {long}",
        "contained_name": "Every word of {shorter} also appears in {longer}",
        "shared_key_words": "Shares key word(s): {words}",
        "similar_spelling": "Similar spelling",
        "same_bpid": "Same BPID: {bpid}",
        "exact_name": "Same name (case and spacing ignored)",
        "different_bpid": "Different BPID: file {file}, existing {existing}",
    }[code]
    return {"code": code, "text": t.format(**kw)}


def compare(a: Profile, b: Profile) -> Optional[Dict[str, Any]]:
    """Compare new `a` with pool member `b`. Returns None (no flag) or
    {"strength", "reasons": [..], "differences": [..]}. Exact-name pairs are handled by the caller."""
    rules: Set[str] = set()
    reasons: List[Dict[str, str]] = []
    A, B = a.core, b.core
    if A and B:
        pairs = _pair(A, B)
        pa = {i for _, ia, _ in pairs for i in ia}
        pb = {j for _, _, jb in pairs for j in jb}
        has_split = any(k == "split" for k, _, _ in pairs)
        non_identical = any(k != "identical" for k, _, _ in pairs)
        if A == B:
            rules.add("R1")
        if len(pa) == len(A) and len(pb) == len(B) and non_identical:
            rules.add("R2")
        short_is_a = len(A) <= len(B)
        S, Ls = (A, B) if short_is_a else (B, A)
        if len(S) < len(Ls):
            s_idx = pa if short_is_a else pb
            # a split word is not a one-to-one pairing, so it never supports "contained name" (golden: Bright Water)
            if len(s_idx) == len(S) and not has_split and any(is_strong(t) for t in S):
                rules.add("R3")
        strong_pairs: List[str] = []
        for kind, ia, jb in pairs:
            toks = [A[i] for i in ia] + [B[j] for j in jb]
            if all(is_strong(t) for t in toks):
                shown = b.core_disp[jb[0]] if kind == "split" and len(ia) == 2 else a.core_disp[ia[0]]
                strong_pairs.append(shown)
        if strong_pairs:
            rules.add("R4")
        digs_a = sorted(t for t in A if any(c.isdigit() for c in t))
        digs_b = sorted(t for t in B if any(c.isdigit() for c in t))
        if (A != B and len(a.joined) >= WHOLE_MIN_LEN and len(b.joined) >= WHOLE_MIN_LEN and digs_a == digs_b):
            lim = max(1, max(len(a.joined), len(b.joined)) // WHOLE_DIVISOR)
            if (a.mask ^ b.mask).bit_count() <= 2 * lim and osa(a.joined, b.joined, lim) <= lim:
                rules.add("R5")
        if rules or (a.bpid_key and a.bpid_key == b.bpid_key and a.ek != b.ek):
            # reasons in a fixed order
            if "R1" in rules:
                reasons.append(_sent("same_core_name"))
            if "R2" in rules:
                diff = []
                for kind, ia, jb in sorted(pairs, key=lambda p: p[1]):
                    if kind != "identical":
                        diff.append(f"{' '.join(a.core_disp[i] for i in ia)} / {' '.join(b.core_disp[j] for j in jb)}")
                reasons.append(_sent("same_words_spelled_differently", pairs="; ".join(diff)))
            for kind, ia, jb in sorted(pairs, key=lambda p: p[1]):
                if kind == "abbreviation":
                    x, y = A[ia[0]], B[jb[0]]
                    sh, lg = (a.core_disp[ia[0]], b.core_disp[jb[0]]) if len(x) <= len(y) else \
                        (b.core_disp[jb[0]], a.core_disp[ia[0]])
                    reasons.append(_sent("abbreviation", short=sh, long=lg))
            if "R3" in rules:
                sd = a.core_disp if short_is_a else b.core_disp
                lname = b.name if short_is_a else a.name
                reasons.append(_sent("contained_name", shorter=" ".join(sd), longer=lname))
            elif "R4" in rules and not (rules & {"R1", "R2"}):
                reasons.append(_sent("shared_key_words", words=", ".join(strong_pairs)))
            if "R5" in rules and not (rules & {"R1", "R2", "R3"}):
                reasons.append(_sent("similar_spelling"))
    else:
        strong_pairs = []
    if a.bpid_key and a.bpid_key == b.bpid_key and a.ek != b.ek:
        rules.add("R6")
        reasons.append(_sent("same_bpid", bpid=b.bpid or ""))
    if not rules:
        return None
    if rules & {"R1", "R2", "R6"}:
        strength = "High"
    elif rules & {"R3", "R5"} or ("R4" in rules and len(strong_pairs) >= 2):
        strength = "Medium"
    else:
        strength = "Low"
    diffs: List[Dict[str, str]] = []
    if a.bpid_key and b.bpid_key and a.bpid_key != b.bpid_key:
        diffs.append(_sent("different_bpid", file=a.bpid or "", existing=b.bpid or ""))
    return {"strength": strength, "reasons": reasons, "differences": diffs}


def order_key(c: Dict[str, Any]) -> Tuple[Any, ...]:
    return (STRENGTH_RANK[c["strength"]], -len(c["reasons"]), c["name"].casefold(), c["_sort_id"])


# ---------------------------------------------------------------- indexed pool


class Entry:
    """A pool member: an existing account or an earlier valid row of the file."""
    __slots__ = ("idx", "ref", "profile", "data", "sort_id")

    def __init__(self, idx: int, ref: Dict[str, Any], profile: Profile, data: Dict[str, Any]) -> None:
        self.idx, self.ref, self.profile, self.data = idx, ref, profile, data
        self.sort_id = ref.get("id") or f"row:{ref.get('row'):08d}"


def _trigrams(s: str) -> Set[str]:
    return {s[i:i + 3] for i in range(len(s) - 2)}


class Matcher:
    """Pool with inverted indexes. Result equals `brute_force` (tested), but 500 rows x 5000 accounts stay fast."""

    def __init__(self) -> None:
        self.entries: List[Entry] = []
        self.by_exact: Dict[str, List[Entry]] = {}
        self.tok: Dict[str, Set[int]] = {}
        self.cat: Dict[str, Set[int]] = {}
        self.first: Dict[str, List[str]] = {}
        self.by_len: Dict[int, List[Tuple[str, int]]] = {}
        self.bpid: Dict[str, Set[int]] = {}
        self.jlen: Dict[int, List[int]] = {}
        self.tri: Dict[str, Set[int]] = {}
        self.cores: Dict[Tuple[str, ...], Set[int]] = {}

    def add(self, ref: Dict[str, Any], name: str, bpid: Optional[str], data: Optional[Dict[str, Any]] = None) -> Entry:
        p = Profile(name, bpid)
        e = Entry(len(self.entries), ref, p, data or {})
        self.entries.append(e)
        self.by_exact.setdefault(p.ek, []).append(e)
        self.cores.setdefault(tuple(p.core), set()).add(e.idx)
        for t in p.core:
            if t not in self.tok:
                self.tok[t] = set()
                if len(t) >= ABBR_MIN_SHORT:
                    self.first.setdefault(t[0], []).append(t)
                if len(t) >= NEAR_MIN_LEN:
                    self.by_len.setdefault(len(t), []).append((t, _mask(t)))
            self.tok[t].add(e.idx)
        for i in range(len(p.core) - 1):
            self.cat.setdefault(p.core[i] + p.core[i + 1], set()).add(e.idx)
        if p.bpid_key:
            self.bpid.setdefault(p.bpid_key, set()).add(e.idx)
        if len(p.joined) >= WHOLE_MIN_LEN:
            self.jlen.setdefault(len(p.joined), []).append(e.idx)
            for g in _trigrams(p.joined):
                self.tri.setdefault(g, set()).add(e.idx)
        return e

    def exact(self, name: str) -> Optional[Entry]:
        lst = self.by_exact.get(exact_key(name))
        return min(lst, key=lambda e: e.sort_id) if lst else None

    # -- shortlist: a superset of everything compare() could flag
    def _shortlist(self, a: Profile) -> Set[int]:
        out: Set[int] = set()
        A = a.core
        out |= self.cores.get(tuple(A), set())          # R1; also the only rule weak identical words can support
        for t in A:
            if t not in WEAK_WORDS:                     # a pair of identical weak words alone can only mean R1
                out |= self.tok.get(t, set())
            out |= self.cat.get(t, set())
        for i in range(len(A) - 1):
            out |= self.tok.get(A[i] + A[i + 1], set())     # split words (any weight)
        for t in set(A):
            if len(t) >= ABBR_MIN_SHORT:
                for u in self.first.get(t[0], ()):
                    if u != t and is_abbreviation(t, u):
                        out |= self.tok[u]
            if len(t) >= NEAR_MIN_LEN:
                tm = _mask(t)
                for L in range(max(NEAR_MIN_LEN, len(t) - NEAR_MAX_DIST_LONG), len(t) + NEAR_MAX_DIST_LONG + 1):
                    k = NEAR_MAX_DIST_SHORT if max(len(t), L) <= 8 else NEAR_MAX_DIST_LONG
                    if abs(L - len(t)) > k:
                        continue
                    for u, um in self.by_len.get(L, ()):
                        if (tm ^ um).bit_count() <= 2 * k and is_near_spelling(t, u):
                            out |= self.tok[u]
        n = len(a.joined)
        if n >= WHOLE_MIN_LEN:
            grams = _trigrams(a.joined)
            counts: Dict[int, int] = {}
            for g in grams:
                for i in self.tri.get(g, ()):
                    counts[i] = counts.get(i, 0) + 1
            for m in range(WHOLE_MIN_LEN, n + n // WHOLE_DIVISOR + 3):
                lim = max(1, max(n, m) // WHOLE_DIVISOR)
                if abs(n - m) > lim:
                    continue
                # q-gram lemma: each edit destroys at most 4 trigram positions, so >= distinct - 4*lim survive
                need = len(grams) - 4 * lim
                for i in self.jlen.get(m, ()):
                    if need > 0 and counts.get(i, 0) < need:
                        continue
                    if (a.mask ^ self.entries[i].profile.mask).bit_count() > 2 * lim:
                        continue
                    out.add(i)
        if a.bpid_key:
            out |= self.bpid.get(a.bpid_key, set())
        return out

    def find(self, name: str, bpid: Optional[str] = None, *, limit: int = MAX_CANDIDATES,
             exclude: Iterable[int] = ()) -> Dict[str, Any]:
        """-> {"exact": Entry|None, "candidates": [ {entry, strength, reasons, differences} ] (ordered, <= limit)}"""
        a = Profile(name, bpid)
        ex = self.exact(name)
        skip = set(exclude)
        found = []
        for i in self._shortlist(a):
            e = self.entries[i]
            if e.idx in skip or (ex is not None and e.idx == ex.idx):
                continue
            if e.profile.ek == a.ek:      # a second exact twin is still "the same account": not a candidate
                continue
            r = compare(a, e.profile)
            if r:
                found.append((e, r))
        found.sort(key=lambda er: (STRENGTH_RANK[er[1]["strength"]], -len(er[1]["reasons"]),
                                   er[0].profile.name.casefold(), er[0].sort_id))
        return {"exact": ex, "candidates": [{"entry": e, **r} for e, r in found[:limit]]}


def exact_reason() -> Dict[str, str]:
    return _sent("exact_name")


def brute_force(matcher: Matcher, name: str, bpid: Optional[str] = None, limit: int = MAX_CANDIDATES) -> List[Tuple[int, str]]:
    """Reference implementation used by tests: compare against every pool member."""
    a = Profile(name, bpid)
    ex = matcher.exact(name)
    found = []
    for e in matcher.entries:
        if (ex is not None and e.idx == ex.idx) or e.profile.ek == a.ek:
            continue
        r = compare(a, e.profile)
        if r:
            found.append((e, r))
    found.sort(key=lambda er: (STRENGTH_RANK[er[1]["strength"]], -len(er[1]["reasons"]),
                               er[0].profile.name.casefold(), er[0].sort_id))
    return [(e.idx, r["strength"]) for e, r in found[:limit]]

"""BAMS import plan (D-63..D-68): account resolution, exact keys, ticker conflicts, per-account similar-appliance
matching (the Run 3 engine in server/dupes.py), and resolution of the user's decisions. Pure: rows + snapshot in,
plan out; no database access, no clock."""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from .. import constants as C
from .. import dupes
from ..errors import ValidationFailed
from .bams_reader import LABELS
from .reader import ParsedRow, _err

FILL = ("region", "location", "environment")


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def _fills_kept(file_vals: Dict[str, Any], existing: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Dict[str, Any]]]:
    fills: Dict[str, str] = {}
    kept: Dict[str, Dict[str, Any]] = {}
    for f in FILL:
        fv, ev = file_vals.get(f), existing.get(f)
        if _blank(fv):
            continue
        if _blank(ev):
            fills[f] = fv
        else:
            kept[f] = {"existing": ev, "file": fv, "differs": fv != ev}
    return fills, kept


def _ek(name: str) -> str:
    return dupes.exact_key(name)


def _nums(name: str) -> List[int]:
    return [int(w) for w in dupes.words(name) if w.isdigit()]


def _alpha(name: str) -> List[str]:
    return [dupes.match_key(w)[0] for w in dupes.words(name) if not w.isdigit()]


def find_similar_appliances(mt: "dupes.Matcher", name: str) -> List[Dict[str, Any]]:
    """The Run 3 engine over one account's appliance names, plus the appliance-specific rule (D-67): numbered units are
    different appliances (ldn-01 vs ldn-03), so a candidate must carry the same numbers (01 equals 1), and a match built
    only on shared words needs the same name words (cpg-... vs tbf-... is not a duplicate). Reasons, strength words and
    order are the engine's, unchanged."""
    out = []
    nums, alpha = _nums(name), _alpha(name)
    for c in mt.find(name, None, limit=500)["candidates"]:
        e = c["entry"]
        other = e.data["obj"]["name"] if e.data["kind"] == "appliance" else e.data["group"].name
        if _nums(other) != nums:
            continue
        only_shared = all(r["code"] == "shared_key_words" for r in c["reasons"])
        if c["strength"] == "High" or not only_shared or _alpha(other) == alpha:
            out.append(c)
        if len(out) >= C.IMPORT_MAX_CANDIDATES:
            break
    return out


class BRow:
    def __init__(self, p: ParsedRow) -> None:
        self.row, self.values, self.raw, self.errors = p.row, p.values, p.raw, list(p.errors)
        self.state = "invalid" if self.errors else ""
        self.warnings: List[Dict[str, str]] = []
        self.notes: List[str] = []
        self.client: Optional[Dict[str, Any]] = None
        self.obj: Optional[Dict[str, Any]] = None
        self.metric: Optional[Dict[str, Any]] = None
        self.pending: Optional[Dict[str, Any]] = None     # ticker owned by a metric elsewhere (may resolve via "Same")
        self.group: Optional[str] = None
        self.review_key: Optional[str] = None
        self.fills: Dict[str, str] = {}
        self.kept: Dict[str, Any] = {}

    @property
    def key(self) -> Tuple[str, str, str]:
        return (self.client["id"] if self.client else "", _ek(self.values["appliance"] or ""), (self.values["metric"] or "").casefold())

    def fail(self, field: str, code: str, text: str) -> None:
        self.state = "invalid"
        self.errors.append({"field": field, "code": code, "text": text})

    def public(self) -> Dict[str, Any]:
        raw = None
        if self.state == "invalid":
            raw = {k: (v if len(v) <= 500 else v[:499] + "…") for k, v in self.raw.items()}
        target = None
        if self.client is not None:
            target = {"client_id": self.client["id"], "client_name": self.client["name"],
                      "appliance": {"id": self.obj["id"] if self.obj else None,
                                    "name": self.obj["name"] if self.obj else self.values["appliance"],
                                    "is_new": self.obj is None},
                      "metric": {"id": self.metric["id"] if self.metric else None, "is_new": self.metric is None}}
        return {"row": self.row, "state": self.state, "values": self.values, "raw": raw, "target": target,
                "group": self.group, "review_key": self.review_key, "fills": self.fills, "kept": self.kept,
                "errors": self.errors, "warnings": self.warnings, "notes": self.notes}


class Group:
    def __init__(self, key: str, client: Dict[str, Any], rows: List[BRow], obj: Optional[Dict[str, Any]], name: str) -> None:
        self.key, self.client, self.rows, self.obj, self.name = key, client, rows, obj, name
        self.flagged = False
        self.candidates: List[Dict[str, Any]] = []
        self.cand_refs: List[Dict[str, Any]] = []
        self.strength: Optional[str] = None

    def file_values(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for f in FILL:
            for r in self.rows:
                if not _blank(r.values.get(f)):
                    out[f] = r.values[f]
                    break
        return out

    def valid_rows(self) -> List[BRow]:
        return [r for r in self.rows if r.state != "invalid"]


class BPlan:
    def __init__(self, rows: List[BRow], groups: List[Group], snap: Dict[str, Any]) -> None:
        self.rows, self.groups = rows, groups
        self.by_row = {r.row: r for r in rows}
        self.by_key = {g.key: g for g in groups}
        self.snap = snap
        c = {"rows": len(rows), "valid": 0, "new": 0, "updates": 0, "unchanged": 0, "needs_review": 0, "invalid": 0}
        for r in rows:
            if r.state == "invalid":
                c["invalid"] += 1
                continue
            c["valid"] += 1
            c[{"new": "new", "update": "updates", "unchanged": "unchanged", "needs_review": "needs_review"}[r.state]] += 1
        self.counts = c
        ap = {"new": 0, "updated": 0, "unchanged": 0, "needs_review": 0}
        for g in groups:
            vr = g.valid_rows()
            if not vr:
                continue
            if g.flagged:
                ap["needs_review"] += 1
            elif g.obj is None:
                ap["new"] += 1
            elif any(r.state in ("new", "update") for r in vr):
                ap["updated"] += 1
            else:
                ap["unchanged"] += 1
        self.appliances = ap
        self.metrics = {"new": c["new"], "updated": c["updates"], "unchanged": c["unchanged"]}
        self.plan_hash = self._hash()

    def review(self) -> List[Dict[str, Any]]:
        out = []
        for g in self.groups:
            if not g.flagged or not g.valid_rows():
                continue
            fv = g.file_values()
            out.append({"key": g.key, "client_id": g.client["id"], "client_name": g.client["name"],
                        "rows": [r.row for r in g.valid_rows()],
                        "file": {"appliance": g.name, "region": fv.get("region"), "location": fv.get("location"),
                                 "environment": fv.get("environment"),
                                 "metrics": [r.values["metric"] for r in g.valid_rows()]},
                        "strength": g.strength, "candidates": g.candidates})
        return out

    def _hash(self) -> str:
        parts: List[Any] = []
        for r in self.rows:
            e: List[Any] = [r.row, r.state, [x["code"] for x in r.errors], r.group, r.fills]
            if r.client:
                e.append([r.client["id"], r.obj["id"] if r.obj else None, r.obj["row_version"] if r.obj else None,
                          r.metric["id"] if r.metric else None, r.metric["ticker"] if r.metric else None])
            parts.append(e)
        for g in self.review():
            parts.append(["g", g["key"], g["rows"]] + [[c["ref"], c["name"], c.get("row_version"), c["strength"],
                          [x["code"] for x in c["reasons"]], c["fills"], c["metrics_added"], c["metrics_existing"],
                          c["metrics_conflicts"]] for c in g["candidates"]])
        self.sigs: Dict[int, str] = {
            e[0]: hashlib.sha1(json.dumps(e, sort_keys=True, ensure_ascii=False, default=str).encode(), usedforsecurity=False).hexdigest()[:12]
            for e in parts if isinstance(e[0], int)}
        blob = json.dumps(parts, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
        return "sha256:" + hashlib.sha256(blob.encode()).hexdigest()


# ======================================================================= build


def _row_err(r: BRow, fld: str, code: str, problem: str) -> None:
    r.fail(fld, code, _err(r.row, fld, code, problem, LABELS)["text"])


def _resolve_account(r: BRow, by_bpid: Dict[str, List[Dict[str, Any]]], by_name: Dict[str, List[Dict[str, Any]]]) -> None:
    v = r.values
    by_b = by_bpid.get(v["bpid"].strip().casefold(), []) if v["bpid"] else []
    by_n = by_name.get(_ek(v["account"]), []) if v["account"] else []
    if len(by_b) > 1 or len(by_n) > 1:
        _row_err(r, "account", "account_ambiguous", "matches more than one account; use the BPID or fix the name")
        return
    if by_b and by_n and by_b[0]["id"] != by_n[0]["id"]:
        _row_err(r, "account", "account_mismatch", f"the BPID belongs to {by_b[0]['name']} but the name is {by_n[0]['name']}")
        return
    if v["bpid"] and not by_b:      # QA-E5-1 (PM ruling): a BPID that matches no account is Invalid, even with a valid name
        _row_err(r, "account", "account_not_found", f"BPID {v['bpid']} is not an account in the tracker (accounts are never created by this import)")
        return
    c = by_b[0] if by_b else (by_n[0] if by_n else None)
    if c is None:
        what = f"BPID {v['bpid']}" if v["bpid"] and not v["account"] else f"'{v['account']}'"
        _row_err(r, "account", "account_not_found", f"{what} is not an account in the tracker (accounts are never created by this import)")
        return
    r.client = c


def build_plan(parsed: List[ParsedRow], snap: Dict[str, Any]) -> BPlan:
    rows = [BRow(p) for p in parsed]
    clients = snap["clients"]
    by_bpid: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_name: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for c in clients:
        if c.get("bpid"):
            by_bpid[c["bpid"].strip().casefold()].append(c)
        by_name[_ek(c["name"])].append(c)
    objs: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for o in snap["objects"]:
        objs.setdefault((o["client_id"], _ek(o["name"])), o)
    metrics_of: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    owners: Dict[str, Dict[str, Any]] = {}
    for m in snap["metrics"]:
        metrics_of[m["object_id"]].append(m)
        owners.setdefault(m["ticker"].casefold(), m)

    for r in rows:                                                    # A: accounts
        if r.state != "invalid":
            _resolve_account(r, by_bpid, by_name)
    live = [r for r in rows if r.state != "invalid"]
    by_ticker: Dict[str, List[BRow]] = defaultdict(list)             # B: inside the file
    for r in live:
        by_ticker[r.values["ticker"].casefold()].append(r)
    for t, rs in by_ticker.items():
        if len({r.key for r in rs}) > 1:
            for r in rs:
                other = next(x for x in rs if x.key != r.key)
                r.fail("ticker", "ticker_repeated_in_file",
                       f"Row {r.row}: Ticker {r.values['ticker']} is also used on row {other.row} for a different metric. "
                       "Both rows are skipped; each ticker belongs to one metric.")
    seen: Dict[Tuple[Any, ...], int] = {}
    seen_metric: Dict[Tuple[str, str, str], BRow] = {}
    for r in rows:
        if r.state == "invalid":
            continue
        k = r.key + (r.values["ticker"].casefold(),)
        if k in seen:
            r.fail("metric", "repeats_row", f"Row {r.row}: repeats row {seen[k]} (same appliance, metric and ticker). This row will be skipped.")
            continue
        seen[k] = r.row
        first = seen_metric.get(r.key)
        if first is not None:
            r.fail("ticker", "ticker_differs", f"Row {r.row}: Metric {r.values['metric']} on {r.values['appliance']} also appears "
                   f"on row {first.row} with a different ticker. This row will be skipped.")
            continue
        seen_metric[r.key] = r
    obj_lookup: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:                                                    # C: database
        if r.state == "invalid":
            continue
        r.obj = objs.get((r.client["id"], _ek(r.values["appliance"])))
        if r.obj is not None:
            mk = r.values["metric"].casefold()
            cands = [m for m in metrics_of[r.obj["id"]] if m["metric_name"].casefold() == mk]
            r.metric = next((m for m in cands if m["metric_name"] == r.values["metric"]), cands[0] if cands else None)
        t = r.values["ticker"]
        if r.metric is not None:
            if r.metric["ticker"].casefold() != t.casefold():
                r.fail("ticker", "ticker_differs",
                       f"Row {r.row}: Metric {r.metric['metric_name']} on {r.obj['name']} already uses ticker "
                       f"{r.metric['ticker']}. Tickers are never changed by import (change it in BAMS); this row will be skipped.")
        else:
            o = owners.get(t.casefold())
            if o is not None:
                if r.obj is None:
                    r.pending = o
                else:
                    _ticker_conflict(r, o)
    # D/E: groups, similar appliances
    groups: List[Group] = []
    gmap: Dict[Tuple[str, str], Group] = {}
    for r in rows:
        if r.state == "invalid":
            continue
        k = (r.client["id"], _ek(r.values["appliance"]))
        g = gmap.get(k)
        if g is None:
            g = gmap[k] = Group(f"g{r.row}", r.client, [], r.obj, r.values["appliance"])
            groups.append(g)
        g.rows.append(r)
    matchers: Dict[str, dupes.Matcher] = {}
    for g in groups:
        cid = g.client["id"]
        if cid not in matchers:
            mt = dupes.Matcher()
            for o in sorted((o for o in snap["objects"] if o["client_id"] == cid), key=lambda o: o["id"]):
                mt.add({"type": "appliance", "id": o["id"]}, o["name"], None, data={"kind": "appliance", "obj": o})
            matchers[cid] = mt
        mt = matchers[cid]
        if g.obj is None:
            cands = find_similar_appliances(mt, g.name)
            g.candidates = [_cand_payload(c, g, metrics_of) for c in cands]
            g.cand_refs = [c["entry"].ref for c in cands]
            g.flagged = bool(cands)
            _settle_pending(g, metrics_of)
            if g.flagged and g.candidates:
                g.strength = g.candidates[0]["strength"]
            mt.add({"type": "group", "key": g.key}, g.name, None, data={"kind": "group", "group": g})
    for g in groups:                                                  # states
        vr = g.valid_rows()
        if not vr:
            continue
        fv = g.file_values()
        for r in vr:
            r.group = g.key
        if g.flagged:
            for r in vr:
                r.state, r.review_key = "needs_review", g.key
                r.notes = ["Possible duplicate appliance: choose Same, Different or Skip."]
            continue
        if g.obj is None:
            for r in vr:
                r.state = "new"
                r.notes = ["New appliance."]
            continue
        fills, kept = _fills_kept(fv, g.obj)
        vr[0].fills, vr[0].kept = fills, kept
        for f, k in kept.items():
            if k["differs"]:
                vr[0].warnings.append({"code": "kept_differs", "text": f"{LABELS[f]} in the file ({k['file']}) differs from the "
                                       f"appliance ({k['existing']}); the existing value is kept."})
        for r in vr:
            if r.metric is None:
                r.state, r.notes = "new", ["New metric on an existing appliance."]
            else:
                r.state = "update" if fills else "unchanged"
                r.notes = ([f"Same ticker. Fills {', '.join(LABELS[f] for f in fills)} only."] if fills
                           else ["Already in BAMS; nothing to change."])
                m = r.metric
                if (r.raw.get("enabled", "") != "" and bool(m["enabled"]) != r.values["enabled"]) or \
                        (r.raw.get("stale_after_seconds", "") != "" and m["stale_after_seconds"] != r.values["stale_after_seconds"]):
                    r.warnings.append({"code": "enabled_ignored", "text": "Enabled / Stale after in the file differ from the "
                                       "existing metric; the existing settings are kept."})
    return BPlan(rows, groups, snap)


def _ticker_conflict(r: BRow, o: Dict[str, Any]) -> None:
    r.pending = None
    r.fail("ticker", "ticker_conflict",
           f"Row {r.row}: Ticker {r.values['ticker']} is already used by {o['metric_name']} on {o['object_name']} "
           f"({o['client_name']}). Tickers are never changed by import; this row will be skipped.")


def _settle_pending(g: Group, metrics_of: Dict[str, List[Dict[str, Any]]]) -> None:
    """Rows whose ticker belongs to an existing metric stay valid only when a similar appliance candidate owns that very
    metric (name match); otherwise they are ticker conflicts."""
    cand_ids = {c["ref"]["id"] for c in g.candidates if c["ref"]["type"] == "appliance"} if g.flagged else set()
    for r in g.rows:
        o = r.pending
        if o is None or r.state == "invalid":
            continue
        if o["object_id"] in cand_ids and o["metric_name"].casefold() == r.values["metric"].casefold():
            continue
        _ticker_conflict(r, o)
    if g.flagged and not g.valid_rows():
        g.flagged = False
    if g.flagged:
        for c in g.candidates:                       # recompute with the final set of valid rows
            _refresh_cand(c, g, metrics_of)


def _refresh_cand(c: Dict[str, Any], g: Group, metrics_of: Dict[str, List[Dict[str, Any]]]) -> None:
    existing = {m["metric_name"].casefold(): m for m in metrics_of.get(c["ref"].get("id", ""), [])} if c["ref"]["type"] == "appliance" else {}
    added, same, conflicts = [], [], []
    for r in g.valid_rows():
        m = existing.get(r.values["metric"].casefold())
        if m is None:
            added.append(r.values["metric"])
        elif m["ticker"].casefold() == r.values["ticker"].casefold():
            same.append(r.values["metric"])
        else:
            conflicts.append({"metric": r.values["metric"], "ticker": r.values["ticker"], "owner": c["name"],
                              "existing_ticker": m["ticker"]})
    c["metrics_added"], c["metrics_existing"], c["metrics_conflicts"] = added, same, conflicts


def _cand_payload(c: Dict[str, Any], g: Group, metrics_of: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    e = c["entry"]
    d = e.data
    fv = g.file_values()
    if d["kind"] == "appliance":
        o = d["obj"]
        existing_metrics = metrics_of.get(o["id"], [])
        fills, kept = _fills_kept(fv, o)
        out = {"ref": e.ref, "name": o["name"], "region": o["region"], "location": o["location"],
               "environment": o["environment"], "enabled": bool(o["enabled"]), "row_version": o["row_version"],
               "metric_count": len(existing_metrics), "metrics": [m["metric_name"] for m in existing_metrics][:30]}
    else:
        og: Group = d["group"]
        gv = og.file_values()
        fills, kept = _fills_kept(fv, gv)
        out = {"ref": e.ref, "name": og.name, "region": gv.get("region"), "location": gv.get("location"),
               "environment": gv.get("environment"), "enabled": True, "metric_count": len(og.valid_rows()),
               "metrics": [r.values["metric"] for r in og.valid_rows()][:30]}
    out.update(strength=c["strength"], reasons=c["reasons"], differences=c["differences"], fills=fills, kept=kept,
               metrics_added=[], metrics_existing=[], metrics_conflicts=[], notes=[])
    _refresh_cand(out, g, metrics_of) if d["kind"] == "appliance" else _refresh_group_cand(out, g, d["group"])
    return out


def _refresh_group_cand(c: Dict[str, Any], g: Group, og: Group) -> None:
    have = {r.values["metric"].casefold(): r for r in og.valid_rows()}
    for r in g.valid_rows():
        m = have.get(r.values["metric"].casefold())
        if m is None:
            c["metrics_added"].append(r.values["metric"])
        elif m.values["ticker"].casefold() == r.values["ticker"].casefold():
            c["metrics_existing"].append(r.values["metric"])
        else:
            c["metrics_conflicts"].append({"metric": r.values["metric"], "ticker": r.values["ticker"], "owner": og.name,
                                           "existing_ticker": m.values["ticker"]})


# ======================================================================= decisions


def _bad(msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={"decisions": msg})


def validate_decisions(plan: BPlan, decisions: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}
    for d in decisions:
        k = d["key"]
        if k in by_key:
            raise _bad(f"{k}: more than one decision")
        g = plan.by_key.get(k)
        if g is None or not g.flagged or not g.valid_rows():
            raise _bad(f"{k}: this appliance does not need a decision")
        t = d.get("target")
        if d["choice"] == "same":
            if not t:
                raise _bad(f"{k}: choose which appliance it is the same as")
            if not any(_ref_eq(t, ref) for ref in g.cand_refs):
                raise _bad(f"{k}: that target is not one of this appliance's candidates")
        elif t:
            raise _bad(f"{k}: a target is only allowed with 'same'")
        by_key[k] = d
    for k, d in by_key.items():
        t = d.get("target")
        if d["choice"] == "same" and t["type"] == "group" and by_key.get(t["key"], {}).get("choice") == "skip":
            raise _bad(f"{k}: 'same' cannot point at {t['key']} because that appliance is skipped")
    return by_key


def _ref_eq(t: Dict[str, Any], ref: Dict[str, Any]) -> bool:
    if t.get("type") != ref.get("type"):
        return False
    return t.get("id") == ref.get("id") if ref["type"] == "appliance" else t.get("key") == ref.get("key")


class Dest:
    def __init__(self, key: str, obj: Optional[Dict[str, Any]], client: Dict[str, Any], name: str) -> None:
        self.key, self.obj, self.client, self.name = key, obj, client, name
        self.pool: Dict[str, Any] = {}
        self.rows: List[int] = []
        self.created: List[BRow] = []
        self.unchanged_rows: List[BRow] = []
        self.metrics: Dict[str, str] = {}              # metric name casefold -> ticker casefold
        self.fills: Dict[str, str] = {}
        self.marked_same = False
        self.marked_different = False
        self.exact = False

    @property
    def is_new(self) -> bool:
        return self.obj is None


def resolve(plan: BPlan, by_key: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    metrics_of: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for m in plan.snap["metrics"]:
        metrics_of[m["object_id"]].append(m)
    obj_by_id = {o["id"]: o for o in plan.snap["objects"]}
    dests: Dict[str, Dest] = {}
    dest_of: Dict[str, Optional[Dest]] = {}
    skipped: List[Dict[str, Any]] = []
    labels: List[Dict[str, Any]] = []

    def existing_dest(o: Dict[str, Any], client: Dict[str, Any]) -> Dest:
        d = dests.get("o:" + o["id"])
        if d is None:
            d = dests["o:" + o["id"]] = Dest("o:" + o["id"], o, client, o["name"])
            d.metrics = {m["metric_name"].casefold(): m["ticker"].casefold() for m in metrics_of[o["id"]]}
            d.pool = {f: o.get(f) for f in FILL}
        return d

    for r in plan.rows:
        if r.state == "invalid":
            skipped.append({"row": r.row, "name": _row_name(r), "kind": "invalid",
                            "reason": "; ".join(_reason(e["text"]) for e in r.errors)})
    for g in plan.groups:
        vr = g.valid_rows()
        if not vr:
            dest_of[g.key] = None
            continue
        dec = by_key.get(g.key)
        dest: Optional[Dest]
        if g.flagged:
            assert dec is not None
            if dec["choice"] == "skip":
                top = g.candidates[0]["name"] if g.candidates else ""
                for r in vr:
                    skipped.append({"row": r.row, "name": _row_name(r), "kind": "by_user",
                                    "reason": f"Skipped by you (possible duplicate of {top})", "duplicate_of": top})
                dest_of[g.key] = None
                labels.append({"key": g.key, "choice": "skip", "label": f"{g.name} skipped"})
                continue
            if dec["choice"] == "different":
                dest = dests["n:" + g.key] = Dest("n:" + g.key, None, g.client, g.name)
                dest.marked_different = True
                labels.append({"key": g.key, "choice": "different", "label": f"{g.name} created as new"})
            else:
                t = dec["target"]
                if t["type"] == "appliance":
                    dest = existing_dest(obj_by_id[t["id"]], g.client)
                else:
                    dest = dest_of.get(t["key"])
                    if dest is None:
                        raise _bad(f"{g.key}: 'same' cannot point at {t['key']} because that appliance has no rows to write")
                dest.marked_same = True
                labels.append({"key": g.key, "choice": "same", "label": f"{g.name} merged into {dest.name}"})
        elif g.obj is not None:
            dest = existing_dest(g.obj, g.client)
            dest.exact = True
        else:
            dest = dests["n:" + g.key] = Dest("n:" + g.key, None, g.client, g.name)
        dest_of[g.key] = dest
        fv = g.file_values()
        for f in FILL:
            if _blank(dest.pool.get(f)) and not _blank(fv.get(f)):
                dest.pool[f] = fv[f]
                if not dest.is_new:
                    dest.fills[f] = fv[f]
        for r in vr:
            dest.rows.append(r.row)
            mk, tk = r.values["metric"].casefold(), r.values["ticker"].casefold()
            have = dest.metrics.get(mk)
            if have is not None:
                if have == tk:
                    dest.unchanged_rows.append(r)
                else:
                    skipped.append({"row": r.row, "name": _row_name(r), "kind": "invalid",
                                    "reason": f"Metric {r.values['metric']} already exists on {dest.name} with a different ticker; "
                                              "tickers are never changed by import"})
            elif r.pending is not None:
                o = r.pending
                skipped.append({"row": r.row, "name": _row_name(r), "kind": "invalid",
                                "reason": f"Ticker {r.values['ticker']} is already used by {o['metric_name']} on {o['object_name']} ({o['client_name']})"})
            else:
                dest.metrics[mk] = tk
                dest.created.append(r)
    out = [d for d in dests.values() if not (d.is_new and not d.created)]
    skipped.sort(key=lambda x: x["row"])
    return {"dests": out, "skipped": skipped, "decisions": labels}


def _row_name(r: BRow) -> str:
    return f"{r.values.get('appliance') or r.raw.get('appliance') or ''} / {r.values.get('metric') or r.raw.get('metric') or ''}".strip(" /")


def _reason(text: str) -> str:
    t = text.split(": ", 1)[1] if text.startswith("Row ") and ": " in text else text
    return t.split(". This row will be skipped")[0].split("; this row will be skipped")[0]

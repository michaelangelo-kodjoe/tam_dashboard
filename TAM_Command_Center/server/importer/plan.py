"""Matching and the import plan (PM D-39..D-44, D-47). Pure: parsed rows + account records in, plan out.
No database access, no clock. `resolve()` turns a plan plus the user's decisions into per-account operations."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

from .. import constants as C
from .. import dupes
from ..errors import ValidationFailed
from .reader import FIELDS, ParsedRow

FILL_FIELDS = ("bpid", "products", "next_contact", "notes")     # status is never filled (never blank on an account)
INACTIVE_NOTE = "Existing account is Inactive and stays Inactive"


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def fills_kept(file_vals: Dict[str, Optional[str]], existing: Dict[str, Optional[str]]
               ) -> Tuple[Dict[str, str], Dict[str, Dict[str, Any]]]:
    """Fill blanks only. kept: {field: {existing, file, differs}} where both sides hold a value."""
    fills: Dict[str, str] = {}
    kept: Dict[str, Dict[str, Any]] = {}
    for f in FILL_FIELDS + ("status",):
        fv, ev = file_vals.get(f), existing.get(f)
        if _blank(fv):
            continue
        if _blank(ev):
            if f != "status":
                fills[f] = fv
        else:
            kept[f] = {"existing": ev, "file": fv, "differs": fv != ev}
    return fills, kept


class PlanRow:
    __slots__ = ("row", "state", "values", "raw", "errors", "warnings", "match", "candidates", "merged_into",
                 "unchanged", "exact_account", "cand_refs")

    def __init__(self, p: ParsedRow) -> None:
        self.row, self.values, self.raw, self.errors = p.row, p.values, p.raw, p.errors
        self.state = "invalid" if p.errors else ""
        self.warnings: List[Dict[str, str]] = []
        self.match: Optional[Dict[str, Any]] = None
        self.candidates: List[Dict[str, Any]] = []
        self.merged_into: Optional[int] = None
        self.unchanged = False
        self.exact_account: Optional[str] = None
        self.cand_refs: List[Dict[str, Any]] = []

    def public(self) -> Dict[str, Any]:
        raw = None
        if self.state == "invalid":
            raw = {k: (v if len(v) <= 500 else v[:499] + "…") for k, v in self.raw.items()}
        d: Dict[str, Any] = {"row": self.row, "state": self.state, "values": self.values, "raw": raw,
                             "errors": self.errors, "warnings": self.warnings, "match": self.match,
                             "candidates": self.candidates}
        if self.merged_into is not None:
            d["merged_into"] = {"row": self.merged_into}
        if self.state == "update":
            d["unchanged"] = self.unchanged
        return d


class Plan:
    def __init__(self, rows: List[PlanRow], accounts: Dict[str, Dict[str, Any]]) -> None:
        self.rows = rows
        self.by_row = {r.row: r for r in rows}
        self.accounts = accounts
        c = {"rows": len(rows), "valid": 0, "new": 0, "updates": 0, "needs_review": 0, "invalid": 0, "unchanged": 0}
        for r in rows:
            if r.state == "invalid":
                c["invalid"] += 1
            else:
                c["valid"] += 1
                key = {"new": "new", "update": "updates", "needs_review": "needs_review"}[r.state]
                c[key] += 1
                if r.state == "update" and r.unchanged:
                    c["unchanged"] += 1
        self.counts = c
        self.plan_hash = self._hash()

    def _hash(self) -> str:
        parts = []
        for r in self.rows:
            entry: List[Any] = [r.row, r.state, r.merged_into, [e["code"] for e in r.errors]]
            if r.match:
                a = r.match["account"]
                entry.append(["m", a["id"], a["name"], a["row_version"], r.match["fills"]])
            for c in r.candidates:
                entry.append(["c", c["ref"], c["name"], c.get("row_version"), c["strength"],
                              [x["code"] for x in c["reasons"]], c["fills"]])
            parts.append(entry)
        self.sigs: Dict[int, str] = {
            e[0]: hashlib.sha1(json.dumps(e, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]
            for e in parts}
        blob = json.dumps(parts, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _cand_payload(e: "dupes.Entry", m: Dict[str, Any], file_vals: Dict[str, Any]) -> Dict[str, Any]:
    d = e.data
    existing = {k: d.get(k) for k in ("bpid", "products", "status", "next_contact", "notes")}
    fills, kept = fills_kept(file_vals, existing)
    notes = [INACTIVE_NOTE] if d.get("status") == "Inactive" and e.ref["type"] == "account" else []
    out = {"ref": e.ref, "name": d.get("name") or e.profile.name, "bpid": d.get("bpid"), "products": d.get("products"),
           "status": d.get("status"), "next_contact": d.get("next_contact"),
           "strength": m["strength"], "reasons": m["reasons"], "differences": m["differences"],
           "fills": fills, "kept": kept, "notes": notes}
    if e.ref["type"] == "account":
        out["row_version"] = d["row_version"]
    return out


def _merge(found_a: List[Dict[str, Any]], found_b: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    allc = found_a + found_b
    allc.sort(key=lambda c: (dupes.STRENGTH_RANK[c["strength"]], -len(c["reasons"]), c["entry"].profile.name.casefold(),
                             c["entry"].sort_id))
    return allc[:C.IMPORT_MAX_CANDIDATES]


def build_account_matcher(accounts: List[Dict[str, Any]]) -> "dupes.Matcher":
    mt = dupes.Matcher()
    for a in sorted(accounts, key=lambda a: a["id"]):
        mt.add({"type": "account", "id": a["id"]}, a["name"], a.get("bpid"), data=a)
    return mt


def build_plan(parsed: List[ParsedRow], accounts: List[Dict[str, Any]], matcher: Optional["dupes.Matcher"] = None) -> Plan:
    db = matcher or build_account_matcher(accounts)
    acc_by_id = {a["id"]: a for a in accounts}
    bpid_owner: Dict[str, List[Dict[str, Any]]] = {}
    for a in accounts:
        if a.get("bpid"):
            bpid_owner.setdefault(a["bpid"].strip().casefold(), []).append(a)
    rows_pool = dupes.Matcher()
    exact_rows: Dict[str, PlanRow] = {}
    running: Dict[int, Dict[str, Any]] = {}       # root row -> accumulated values of a new account / existing + fills
    out: List[PlanRow] = []
    for p in parsed:
        r = PlanRow(p)
        out.append(r)
        if r.state == "invalid":
            continue
        v = r.values
        ek = dupes.exact_key(v["name"])
        root = exact_rows.get(ek)
        if root is not None:                                    # in-file exact duplicate: follows the earlier row
            rt = root
            while rt.merged_into is not None:
                rt = exact_rows[dupes.exact_key(rt.values["name"])]
            r.merged_into = rt.row
            r.state = "update" if rt.state == "update" else "new"
            base = running.setdefault(rt.row, dict(rt.values) if rt.state != "update" else
                                      _acc_existing(acc_by_id[rt.exact_account]))
            fills, kept = fills_kept(v, base)
            for k, val in fills.items():
                base[k] = val
            if rt.state == "update":
                r.exact_account = rt.exact_account
                acc = acc_by_id[rt.exact_account]
                r.match = _match_payload(acc, fills, kept)
                r.unchanged = not fills
            continue
        exact_rows[ek] = r
        ex = db.exact(v["name"])
        if ex is not None:
            acc = ex.data
            r.state, r.exact_account = "update", acc["id"]
            base = _acc_existing(acc)
            running[r.row] = base
            fills, kept = fills_kept(v, base)
            r.match = _match_payload(acc, fills, kept)
            r.unchanged = not fills
            if v.get("bpid") and acc.get("bpid") and v["bpid"].casefold() != acc["bpid"].casefold():
                r.warnings.append({"code": "different_bpid", "text":
                                   f"BPID in the file ({v['bpid']}) differs from the account's BPID ({acc['bpid']}); "
                                   "the existing BPID is kept."})
            if v.get("bpid"):
                others = [o["name"] for o in bpid_owner.get(v["bpid"].strip().casefold(), []) if o["id"] != acc["id"]]
                if others:
                    r.warnings.append({"code": "bpid_used_elsewhere",
                                       "text": f"BPID {v['bpid']} is also used by {others[0]}."})
            continue
        fa = db.find(v["name"], v.get("bpid"))
        fb = rows_pool.find(v["name"], v.get("bpid"))
        cands = _merge(fa["candidates"], fb["candidates"])
        if cands:
            r.state = "needs_review"
            r.candidates = [_cand_payload(c["entry"], c, v) for c in cands]
            r.cand_refs = [c["entry"].ref for c in cands]
        else:
            r.state = "new"
        rows_pool.add({"type": "row", "row": r.row}, v["name"], v.get("bpid"), data=dict(v))
        running[r.row] = dict(v)
    return Plan(out, acc_by_id)


def _acc_existing(acc: Dict[str, Any]) -> Dict[str, Any]:
    return {k: acc.get(k) for k in ("name", "bpid", "products", "status", "next_contact", "notes")}


def _match_payload(acc: Dict[str, Any], fills: Dict[str, str], kept: Dict[str, Any]) -> Dict[str, Any]:
    return {"kind": "exact",
            "account": {"id": acc["id"], "name": acc["name"], "status": acc["status"], "row_version": acc["row_version"]},
            "fills": fills, "kept": kept,
            "notes": [INACTIVE_NOTE] if acc["status"] == "Inactive" else [],
            "reasons": [dupes.exact_reason()]}


# ======================================================================= decisions -> operations


class Dest:
    """One account that will be created or touched, with the file rows that contribute to it (row order)."""
    def __init__(self, key: str, account: Optional[Dict[str, Any]], first_row: int) -> None:
        self.key, self.account, self.rows = key, account, [first_row]
        self.exact_row = False
        self.marked_same = False
        self.marked_different = False
        self.values: Dict[str, Optional[str]] = {}
        self.changes: Dict[str, str] = {}

    @property
    def is_new(self) -> bool:
        return self.account is None


def validate_decisions(plan: Plan, decisions: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    """Structure + fresh-plan checks. Returns {row: decision}. Raises ValidationFailed (422). Missing decisions are
    reported by the caller as `unresolved_duplicates` (it needs the row list)."""
    by_row: Dict[int, Dict[str, Any]] = {}
    for d in decisions:
        row = d["row"]
        if row in by_row:
            raise _bad(f"row {row}: more than one decision")
        pr = plan.by_row.get(row)
        if pr is None or pr.state != "needs_review":
            raise _bad(f"row {row}: this row does not need a decision")
        t = d.get("target")
        if d["choice"] == "same":
            if not t:
                raise _bad(f"row {row}: choose which account it is the same as")
            if not any(_ref_eq(t, ref) for ref in pr.cand_refs):
                raise _bad(f"row {row}: that target is not one of this row's candidates")
        elif t:
            raise _bad(f"row {row}: a target is only allowed with 'same'")
        by_row[row] = d
    return by_row


def _bad(msg: str) -> ValidationFailed:
    return ValidationFailed("Request validation failed.", fields={"decisions": msg})


def _ref_eq(t: Dict[str, Any], ref: Dict[str, Any]) -> bool:
    if t.get("type") != ref.get("type"):
        return False
    return t.get("id") == ref.get("id") if ref["type"] == "account" else t.get("row") == ref.get("row")


def resolve(plan: Plan, by_row: Dict[int, Dict[str, Any]]) -> Dict[str, Any]:
    """-> {"dests": [Dest], "skipped": [...], "dest_of": {row: Dest|None}}. Raises ValidationFailed when a 'same'
    target row is skipped (or was itself skipped by merge)."""
    dests: Dict[str, Dest] = {}
    dest_of: Dict[int, Optional[Dest]] = {}
    skipped: List[Dict[str, Any]] = []

    def get_account_dest(acc: Dict[str, Any], row: int) -> Dest:
        d = dests.get("a:" + acc["id"])
        if d is None:
            d = dests["a:" + acc["id"]] = Dest("a:" + acc["id"], acc, row)
            d.values = _acc_existing(acc)
        else:
            d.rows.append(row)
        return d

    for r in plan.rows:
        if r.state == "invalid":
            skipped.append({"row": r.row, "name": r.values.get("name") or r.raw.get("name") or None, "kind": "invalid",
                            "reason": "; ".join(_reason_text(e["text"]) for e in r.errors)})
            dest_of[r.row] = None
            continue
        dest: Optional[Dest]
        if r.merged_into is not None:
            dest = dest_of.get(r.merged_into)
            if dest is None:
                skipped.append({"row": r.row, "name": r.values["name"], "kind": "by_user",
                                "reason": f"Merged into row {r.merged_into}, which was skipped"})
                dest_of[r.row] = None
                continue
            dest.rows.append(r.row)
        elif r.state == "update":
            dest = get_account_dest(plan.accounts[r.exact_account or ""], r.row)
            dest.exact_row = True
        elif r.state == "new":
            dest = dests["n:%d" % r.row] = Dest("n:%d" % r.row, None, r.row)
            dest.values = dict(r.values)
            dest_of[r.row] = dest
            continue
        else:
            d = by_row[r.row]
            if d["choice"] == "skip":
                top = r.candidates[0]["name"] if r.candidates else ""
                skipped.append({"row": r.row, "name": r.values["name"], "kind": "by_user",
                                "reason": f"Skipped by you (possible duplicate of {top})", "duplicate_of": top})
                dest_of[r.row] = None
                continue
            if d["choice"] == "different":
                dest = dests["n:%d" % r.row] = Dest("n:%d" % r.row, None, r.row)
                dest.values = dict(r.values)
                dest.marked_different = True
                dest_of[r.row] = dest
                continue
            t = d["target"]
            if t["type"] == "account":
                dest = get_account_dest(plan.accounts[t["id"]], r.row)
                dest.marked_same = True
            else:
                dest = dest_of.get(t["row"])
                if dest is None:
                    raise _bad(f"row {r.row}: 'same account' cannot point at row {t['row']} because that row is skipped")
                dest.rows.append(r.row)
                dest.marked_same = True
        dest_of[r.row] = dest
        # fill blanks only; earlier rows and existing values win
        for k in FILL_FIELDS + ("status",):
            if _blank(dest.values.get(k)) and not _blank(r.values.get(k)):
                if k == "status" and not dest.is_new:
                    continue
                dest.values[k] = r.values[k]
    out = list(dests.values())
    for d in out:
        if d.is_new:
            d.values["status"] = d.values.get("status") or "Active"
        else:
            base = _acc_existing(d.account)
            d.changes = {k: d.values[k] for k in FILL_FIELDS if _blank(base.get(k)) and not _blank(d.values.get(k))}
    return {"dests": out, "skipped": skipped, "dest_of": dest_of}


def _reason_text(text: str) -> str:
    # "Row 7: Status: ... . This row will be skipped; ..." -> "Status: ..."
    t = text.split(": ", 1)[1] if text.startswith("Row ") and ": " in text else text
    return t.split(". This row will be skipped")[0]

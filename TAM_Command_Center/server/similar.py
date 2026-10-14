"""Single-account similarity check (D-45): the same engine and sentences as the bulk import."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, Optional

from . import dupes
from .importer import plan as P
from .importer import repo


def find_similar(conn: sqlite3.Connection, name: str, bpid: Optional[str]) -> Dict[str, Any]:
    matcher = P.build_account_matcher(repo.load_accounts(conn))
    res = matcher.find(name, bpid)
    ex = res["exact"]
    cands = []
    for c in res["candidates"]:
        d = P._cand_payload(c["entry"], c, {})
        d.pop("fills"); d.pop("kept")
        cands.append(d)
    exact = None
    if ex is not None:
        a = ex.data
        exact = {"id": a["id"], "name": a["name"], "status": a["status"], "row_version": a["row_version"]}
    return {"exact": exact, "candidates": cands}

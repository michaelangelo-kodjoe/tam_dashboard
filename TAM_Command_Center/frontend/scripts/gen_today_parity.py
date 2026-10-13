#!/usr/bin/env python3
"""Regenerate the Today-ranking parity fixtures used by Vitest.

Seeds a scratch SQLite DB with db/seed_mock.py (rebased to each date), runs the
authoritative db/queries/today_queue.sql, and writes the result rows. The TypeScript
port in src/data/mock/today.ts must reproduce the same order (see today.test.ts).
Read-only with respect to db/ (the scratch DB lives in a temp dir).
"""
import json, sqlite3, subprocess, sys, tempfile, os
from pathlib import Path

root = Path(__file__).resolve().parents[2]
db_dir = root / "db"
out_dir = Path(__file__).resolve().parents[1] / "src/data/mock/__fixtures__"
dates = sys.argv[1:] or ["2026-10-12", "2026-10-20", "2026-11-03"]
sql = (db_dir / "queries/today_queue.sql").read_text()
cols = ("section", "tier", "kind", "id", "urgency", "date", "days_delta", "context", "title", "status", "client_name")
for d in dates:
    with tempfile.TemporaryDirectory() as tmp:
        dbp = os.path.join(tmp, "scratch.db")
        subprocess.run([sys.executable, str(db_dir / "seed_mock.py"), "load", "--db", dbp, "--today", d], check=True, capture_output=True)
        c = sqlite3.connect(dbp)
        c.row_factory = sqlite3.Row
        rows = [{k: r[k] for k in cols} for r in c.execute(sql, {"today": d})]
        (out_dir / f"today_parity_{d}.json").write_text(json.dumps(rows))
        print(d, len(rows))

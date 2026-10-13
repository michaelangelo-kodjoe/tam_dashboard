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
sys.path.insert(0, str(db_dir))
import datetime as dt
import seed_mock  # progress_params / trend_params build the UTC-midnight windows used by the reference queries
progress_sql = (db_dir / "queries/day_progress.sql").read_text()
trend_sql = (db_dir / "queries/activity_trend.sql").read_text()
cols = ("section", "tier", "kind", "id", "urgency", "date", "days_delta", "context", "title", "status", "client_name")
for d in dates:
    with tempfile.TemporaryDirectory() as tmp:
        dbp = os.path.join(tmp, "scratch.db")
        subprocess.run([sys.executable, str(db_dir / "seed_mock.py"), "load", "--db", dbp, "--today", d], check=True, capture_output=True)
        c = sqlite3.connect(dbp)
        c.row_factory = sqlite3.Row
        rows = [{k: r[k] for k in cols} for r in c.execute(sql, {"today": d})]
        (out_dir / f"today_parity_{d}.json").write_text(json.dumps(rows))
        # Run 2: progress ring and activity trend, windows = UTC midnights (the vitest MockDataSource is given a UTC midnight)
        day = dt.date.fromisoformat(d)
        c.row_factory = sqlite3.Row
        prog = dict(c.execute(progress_sql, seed_mock.progress_params(day, dt.timezone.utc)).fetchone())
        series = {}
        for r in c.execute(trend_sql, seed_mock.trend_params(day, dt.timezone.utc)):
            series.setdefault(r["client_id"], []).append((r["day_index"], r["n"]))
        series = {k: [n for _, n in sorted(v)] for k, v in series.items()}
        (out_dir / f"run2_parity_{d}.json").write_text(json.dumps({"progress": prog, "trend": series}))
        print(d, len(rows), prog)

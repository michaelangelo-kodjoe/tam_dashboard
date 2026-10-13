"""TAM Command Center: deterministic, relative-date mock seed (DEV only).

Owner: data-architect-agent (Phase 1.2, task T-03). Python 3.9+, stdlib only.

Data flow
---------
  generate  ->  db/mock_data.json     (byte-identical on every run; anchored at
                                       ANCHOR_DATE; all names/emails fictional,
                                       emails use *.example.com only)
  load      ->  SQLite DB             (rebases every date to "today" so the data
                                       never goes stale, then inserts in one
                                       transaction with foreign keys ON)
  verify    ->  prints Today tier counts + edge-case coverage, exit 1 on failure

The frontend MockDataSource (T-23) reads the same JSON and applies the same
rebase rule documented in the file's "rebase" block and in
docs/03_DATA_MODEL.md §8:
  delta_days = today_local - anchor_date
  * every field listed in rebase.date_fields     : date    + delta_days
  * every field listed in rebase.instant_fields  : instant + delta_days (time of day kept)
  * audit_events.old_value/new_value JSON keys in rebase.json_date_keys /
    rebase.json_instant_keys are shifted the same way
  * (schedule_year, schedule_quarter) shift by whole quarters:
    dq = quarter_index(today) - quarter_index(anchor)

Safety
------
* Refuses to load into a file named like the PROD DB (tam_command_center.db).
* Refuses to load into a DB that already holds data unless --reset is given.
  The backend's /api/dev/reseed must take its own pre-delete safety backup
  (online backup API) BEFORE calling load(..., reset=True).
* Stamps app_meta 'db.mock_seed' so a PROD process can refuse a mock DB.

CLI
---
  python db/seed_mock.py generate
  python db/seed_mock.py load   --db dev_data/tam_dev.db [--today YYYY-MM-DD] [--reset]
  python db/seed_mock.py verify --db dev_data/tam_dev.db [--today YYYY-MM-DD]
  python db/seed_mock.py all    --db <scratch.db>        (generate + load + verify)
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import random
import sqlite3
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(DB_DIR))
import migrate  # noqa: E402  (sibling module: reference migration runner)

MOCK_JSON = DB_DIR / "mock_data.json"
TODAY_SQL = DB_DIR / "queries" / "today_queue.sql"
FRESHNESS_SQL = DB_DIR / "queries" / "metric_freshness.sql"
ANCHOR = dt.date(2026, 10, 12)          # the date the JSON is written "as of" (a Monday)
ANCHOR_NOW = dt.datetime(2026, 10, 12, 12, 0, 0)  # the instant BAMS freshness fields are written "as of"
ROW_VERSION_TABLES = ["clients", "contacts", "tasks", "notes", "support_cases", "quarterly_upgrade_windows",
                      "server_upgrades", "bams_objects", "bams_metrics", "bams_alert_rules",
                      "bams_alert_events", "bams_alert_configs"]
# §27 freshness bands used by the seed and the verifier (seconds since last_received)
LIVE_MAX_S, DELAYED_MAX_S = 75, 120
SEED = 20261012
NS = uuid.UUID("6d1f4b8e-2a51-4c1e-9f0e-7a3c5b2d9e10")  # fixed namespace -> stable ids
FORMAT = "tam-mock-v1"
PROD_DB_NAMES = {"tam_command_center.db"}

TABLE_ORDER = [  # parent -> child (insert order); reverse for delete
    "clients", "contacts", "tasks", "notes", "support_cases",
    "quarterly_upgrade_windows", "server_upgrades",
    "bams_objects", "bams_metrics", "bams_alert_rules", "bams_alert_events",
    "bams_metric_samples", "bams_alert_configs", "bams_notification_log",
    "audit_events",
]
STD_TS = ["created_at", "updated_at"]
REBASE = {
    "date_fields": {
        "clients": ["last_contact", "next_contact"],
        "tasks": ["due", "next_update"],
        "quarterly_upgrade_windows": ["notification_date", "dev_upgrade_date", "east_prod_date", "west_prod_date"],
        "server_upgrades": ["scheduled_date"],
        "bams_metrics": ["high_30_date", "high_60_date", "high_90_date"],
    },
    "instant_fields": {
        "clients": STD_TS, "contacts": STD_TS, "tasks": STD_TS, "notes": ["timestamp"] + STD_TS,
        "support_cases": STD_TS,
        "quarterly_upgrade_windows": ["source_sync_at", "updated_at"],
        "server_upgrades": STD_TS, "bams_objects": STD_TS,
        "bams_metrics": ["created_at", "updated_at"],
        "bams_alert_rules": STD_TS,
        "bams_alert_events": ["opened_at", "last_triggered_at", "recovered_at", "closed_at"] + STD_TS,
        "bams_alert_configs": STD_TS,
        "bams_notification_log": ["attempted_at"],
        "audit_events": ["timestamp"],
    },
    "quarter_fields": {"quarterly_upgrade_windows": ["schedule_year", "schedule_quarter"],
                       "server_upgrades": ["schedule_year", "schedule_quarter"]},
    # BAMS freshness fields shift by (load_now - anchor_now) EXACTLY (not whole days), so
    # Live / Delayed / Stale / No Data states survive any load time (QA-1-5).
    "now_relative_fields": {"bams_metrics": ["last_source_update", "last_received"],
                            "bams_metric_samples": ["sampled_at", "source_update"]},
    "json_fields": {"audit_events": ["old_value", "new_value"]},
    "json_date_keys": ["due", "next_update", "next_contact", "last_contact", "scheduled_date"],
    "json_instant_keys": ["timestamp"],
}

# ----------------------------------------------------------------------------- helpers

def uid(kind: str, n: Any) -> str:
    return str(uuid.uuid5(NS, f"{kind}:{n}"))


def d(off: Optional[int]) -> Optional[str]:
    return None if off is None else (ANCHOR + dt.timedelta(days=off)).isoformat()


def ts(off_days: float, hh: int = 0, mm: int = 0, ss: int = 0, ms: int = 0) -> str:
    base = dt.datetime(ANCHOR.year, ANCHOR.month, ANCHOR.day) + dt.timedelta(days=off_days)
    t = base.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(
        days=0, hours=hh, minutes=mm, seconds=ss, milliseconds=ms)
    return fmt_instant(t)


def fmt_instant(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def parse_instant(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ")


def add_minutes(s: str, minutes: float) -> str:
    return fmt_instant(parse_instant(s) + dt.timedelta(minutes=minutes))


LATEST_INSTANT = ts(-1, 20, 0)  # nothing is stamped later than "yesterday 20:00Z" (see §8 of the doc)


def cap(s: str) -> str:
    return s if s <= LATEST_INSTANT else LATEST_INSTANT


def qindex(year: int, quarter: str) -> int:
    return year * 4 + int(quarter[1]) - 1


def qlabel(idx: int) -> Tuple[int, str]:
    return idx // 4, f"Q{idx % 4 + 1}"


def jdump(obj: Any) -> Optional[str]:
    return None if obj is None else json.dumps(obj, sort_keys=True, separators=(",", ":"))

# ----------------------------------------------------------------------------- reference data
# All organisations, people and tickers below are fictional.

ACCOUNTS = [
    # n, abbr, name, status, products, city, alt_city, region, next_contact_off, n_contacts, n_servers
    (1, "NWH", "Northwind Harbor Capital", "Active", "Terminal, B-PIPE", "ny", "nj", "AMER", -2, 4, 4),
    (2, "HFA", "Halvorsen Fjord Asset Management", "Active", "B-PIPE, Server API", "ldn", "ldn", "EMEA", 0, 3, 3),
    (3, "BRS", "Bluewater Reach Securities", "Active", "Terminal, SAPI", "ny", "nj", "AMER", 2, 5, 4),
    (4, "MRA", "Meridian Ridge Advisors", "Active", "B-PIPE", "chi", "ny", "AMER", 6, 3, 3),
    (5, "CPG", "Castellan Peak Global Markets", "Active", "B-PIPE, Data License", "ny", "ldn", "AMER", 9, 4, 5),
    (6, "OLP", "Ostrava Lane Pension Trust", "Active", "Terminal", "fra", "fra", "EMEA", None, 2, 2),
    (7, "KMC", "Kestrelmoor Capital", "Active", "B-PIPE, Terminal", "hk", "sg", "APAC", 20, 3, 3),
    (8, "TBF", "Tidewater Basin Fixed Income", "Active", "Server API", "ny", "nj", "AMER", -1, 3, 3),
    (9, "LHF", "Larchmont Hollow Family Office", "Active", "Terminal", "ny", "ny", "AMER", 13, 1, 2),
    (10, "SCS", "Silverbirch Crossing Strategies", "Active", "B-PIPE", "ldn", "fra", "EMEA", None, 3, 3),
    (11, "AVC", "Aurelian Vale Commodities", "Inactive", "B-PIPE", "sg", "hk", "APAC", -5, 2, 2),
    (12, "PSM", "Pinecrest Shoal Municipal Fund", "Inactive", "Terminal", "ny", "ny", "AMER", None, 2, 1),
]
NO_BAMS = {"LHF", "PSM"}          # LHF = active account with no BAMS objects
NO_PRIMARY = {"SCS"}              # active account with zero primary contacts
LOCATIONS = {"ny": "New York DC1", "nj": "Secaucus DC2", "ldn": "London DC1", "chi": "Chicago DC1",
             "fra": "Frankfurt DC1", "hk": "Hong Kong DC1", "sg": "Singapore DC1"}
FIRST = ["Avery", "Jordan", "Priya", "Mateo", "Hannah", "Kenji", "Leila", "Tomasz", "Grace", "Olusegun",
         "Ingrid", "Rafael", "Mei", "Dmitri", "Sofia", "Callum", "Nadia", "Henrik", "Amara", "Luca",
         "Yuki", "Fatima", "Elliot", "Zara", "Bruno", "Signe", "Arjun", "Clara", "Marcus", "Ines"]
LAST = ["Ashdown", "Brennick", "Calloway", "Delvane", "Ellery", "Fairbrook", "Galloway", "Hartigan",
        "Ishiwara", "Jansky", "Kowalczyk", "Lindqvist", "Marchetti", "Nakamura", "Okonkwo", "Pemberton",
        "Quintero", "Rasmussen", "Sorell", "Takeda", "Underhill", "Valdivia", "Whitcombe", "Xander",
        "Yilmaz", "Zielinski"]
ROLES = [("Head of Market Data", "Market Data"), ("Infrastructure Lead", "Infrastructure"),
         ("Desk Support Manager", "Front Office Technology"), ("Network Engineer", "Infrastructure"),
         ("CTO", "Technology"), ("Market Data Analyst", "Market Data"), ("Risk Systems Lead", "Risk Technology"),
         ("Operations Manager", "Operations")]
WAITING_ON = ["Client infrastructure team", "Bloomberg engineering", "Client network team",
              "Client change board", "Market data vendor desk", "Client procurement"]
CATEGORY_TITLES = {
    "Client Follow-Up": ["Follow up on {topic}", "Send recap of {topic} discussion", "Confirm next steps on {topic}"],
    "Engineering Follow-Up": ["Chase engineering on {server} reconnects", "Confirm fix ETA for {server} gap fills",
                              "Get RCA for {server} latency spike"],
    "Reporting": ["Send monthly usage report", "Compile Q3 incident summary", "Refresh entitlement usage export"],
    "Internal": ["Update account plan", "Prepare coverage handover notes", "Log account context for team review"],
    "Escalation": ["Escalate {server} market data gaps", "Track escalation {ref} to resolution",
                   "Escalate repeated {server} failovers"],
    "Onboarding": ["Schedule onboarding session for {team}", "Onboard new desk users to Terminal",
                   "Walk {team} through B-PIPE permissioning"],
    "Entitlements": ["Review entitlement exceptions for {team}", "Confirm EID mapping for new feed",
                     "Clean up unused entitlements"],
    "Usage Review": ["Run usage review for underused terminals", "Prepare QBR usage review",
                     "Analyse peak-hour B-PIPE usage"],
    "Meeting": ["Prepare agenda for monthly service review", "Book QBR attendees and room",
                "Circulate pre-read for capacity planning"],
    "Other": ["Verify contact list after reorg", "Tidy distribution list", "Archive old project folders"],
}
TOPICS = ["Q4 upgrade timing", "B-PIPE entitlement change", "latency report", "terminal rollout",
          "capacity planning", "DR test results", "new region connectivity", "API migration"]
MEETING_SUBJECTS = ["Quarterly service review", "Monthly service review", "B-PIPE capacity planning session",
                    "Q4 upgrade readiness review", "Onboarding kickoff with {team}", "Incident retrospective: {server}"]
CALL_SUBJECTS = ["Call with {contact}: upgrade timing", "Call: latency complaint follow-up",
                 "Check-in call with {contact}", "Call re entitlement change request", "Call: DR test planning"]
GENERAL_SUBJECTS = ["Account context update", "Internal note: coverage handover", "Observed reconnects on {server}",
                    "Reminder: client change-freeze dates", "Org change on client side"]
BODY_FRAGMENTS = [
    "Client confirmed the maintenance weekend works for the East site.",
    "They asked for a written summary of the change before their CAB meets.",
    "Latency on {server} looked normal after the overnight restart.",
    "Discussed moving two desks onto the new feed next quarter.",
    "{contact} wants a heads-up 48 hours before any failover test.",
    "Raised {ref} for the intermittent gap fills.",
    "No open issues from their side this week.",
    "Agreed to revisit capacity once the new region is live.",
    "They are short-staffed until month end; keep asks lightweight.",
    "Usage is concentrated in the London morning session.",
]
ACTION_FRAGMENTS = ["Send recap to {contact}", "Confirm change window with infra team", "Share usage export",
                    "Book follow-up call", "Check {server} logs for reconnects", "Update account plan"]

# ----------------------------------------------------------------------------- generator

class Gen:
    def __init__(self) -> None:
        self.r = random.Random(SEED)
        self.t: Dict[str, List[Dict[str, Any]]] = {k: [] for k in TABLE_ORDER}
        self.audit: List[Dict[str, Any]] = []
        self.counters: Dict[str, int] = {}

    def nid(self, kind: str) -> str:
        self.counters[kind] = self.counters.get(kind, 0) + 1
        return uid(kind, self.counters[kind])

    def rand_instant(self, lo: int, hi: int) -> str:
        """Business-hours UTC instant between day offsets lo..hi (inclusive), never after LATEST_INSTANT."""
        day = self.r.randint(lo, hi)
        return cap(ts(day, self.r.randint(13, 20), self.r.randint(0, 59), self.r.randint(0, 59), self.r.randint(0, 999)))

    def add_audit(self, timestamp: str, category: str, client_id: Optional[str], object_type: str,
                  object_id: Optional[str], action: str, old: Any = None, new: Any = None,
                  source: str = "GUI", reason: Optional[str] = None, label: Optional[str] = None) -> None:
        if label is None:  # fall back to the natural display field of the snapshot
            for snap in (new or {}, old or {}):
                for k in ("task", "subject", "name", "server_name", "primary_contact"):
                    if isinstance(snap, dict) and snap.get(k):
                        label = snap[k]
                        break
                if label:
                    break
        self.audit.append(dict(timestamp=cap(timestamp), category=category, client_id=client_id,
                               object_type=object_type, object_id=object_id, object_label=label, action=action,
                               old_value=jdump(old), new_value=jdump(new), reason=reason, source=source))

    # ------------------------------------------------------------------ build
    def build(self) -> Dict[str, Any]:
        self.accounts: Dict[str, Dict[str, Any]] = {}
        self.build_clients_contacts()
        self.build_windows_upgrades()
        self.build_bams()
        self.build_tasks()
        self.build_notes()
        self.build_misc_audit()
        self.audit.sort(key=lambda a: (a["timestamp"], a["object_type"], a["object_id"] or "", a["action"]))
        for i, a in enumerate(self.audit, start=1):
            self.t["audit_events"].append({"id": i, **a})
        for t in ROW_VERSION_TABLES:  # edited rows have been updated once
            for row in self.t[t]:
                row["row_version"] = 2 if row.get("created_at") and row["updated_at"] != row["created_at"] else 1
        app_meta = [
            {"key": "setting.default_landing", "value": "today"},
            {"key": "setting.time_display", "value": "local"},
            {"key": "setting.auto_refresh_minutes", "value": "5"},
            {"key": "setting.log_level", "value": "INFO"},
            {"key": "setting.open_browser_on_start", "value": "1"},
        ]
        return {
            "format": FORMAT,
            "anchor_date": ANCHOR.isoformat(),
            "anchor_now": fmt_instant(ANCHOR_NOW),
            "generator": {"script": "db/seed_mock.py", "seed": SEED, "schema_version": 1},
            "notice": "Fictional mock data for DEV only. No real clients, people, tickers or emails.",
            "rebase": REBASE,
            "app_meta": app_meta,
            "tables": self.t,
        }

    # ------------------------------------------------------------------ clients + contacts
    def build_clients_contacts(self) -> None:
        r = self.r
        used_names = set()
        for n, abbr, name, status, products, city, alt, region, nc_off, n_contacts, n_servers in ACCOUNTS:
            cid = uid("client", n)
            created = ts(-r.randint(400, 700), 14, r.randint(0, 59), 0, r.randint(0, 999))
            acct = dict(id=cid, abbr=abbr, name=name, status=status, city=city, alt=alt, region=region,
                        n_servers=n_servers, contacts=[], servers=[])
            self.accounts[abbr] = acct
            row = dict(id=cid, name=name, status=status, bpid=str(r.randint(1_000_000, 9_999_999)),
                       products=products, contact=None, last_contact=None, next_contact=d(nc_off),
                       notes=f"Coverage: {region}. Primary sites {LOCATIONS[city]} / {LOCATIONS[alt]}.",
                       created_at=created, updated_at=created)
            self.t["clients"].append(row)
            acct["row"] = row
            self.add_audit(created, "crm", cid, "client", cid, "created",
                           new={"name": name, "status": "Active", "bpid": row["bpid"]})
            if status == "Inactive":
                when = self.rand_instant(-60, -30)
                self.add_audit(when, "crm", cid, "client", cid, "status_changed", label=name,
                               old={"status": "Active"}, new={"status": "Inactive"},
                               reason="Client consolidated coverage elsewhere")
                row["updated_at"] = max(row["updated_at"], when)
            if nc_off is not None:
                when = self.rand_instant(-6, -1) if status == "Active" else self.rand_instant(-120, -70)
                prev = d(nc_off - r.randint(5, 20))
                self.add_audit(when, "crm", cid, "client", cid, "next_contact_changed", label=name,
                               old={"next_contact": prev}, new={"next_contact": d(nc_off)})
                row["updated_at"] = max(row["updated_at"], when)

            slug = abbr.lower()
            for i in range(n_contacts):
                while True:
                    fn, ln = r.choice(FIRST), r.choice(LAST)
                    if (fn, ln) not in used_names:
                        used_names.add((fn, ln))
                        break
                role, team = r.choice(ROLES)
                c_created = self.rand_instant(-380, -200) if status == "Active" else self.rand_instant(-500, -400)
                ct = dict(id=self.nid("contact"), client_id=cid, name=f"{fn} {ln}", role=role,
                          email=f"{fn.lower()}.{ln.lower()}@{slug}.example.com", team=team,
                          is_primary=0, created_at=c_created, updated_at=c_created)
                if i == 2 and abbr == "BRS":
                    ct["email"] = None  # email is optional
                self.t["contacts"].append(ct)
                acct["contacts"].append(ct)
                self.add_audit(c_created, "crm", cid, "contact", ct["id"], "created",
                               new={"name": ct["name"], "role": role, "team": team})
            if abbr not in NO_PRIMARY and acct["contacts"]:
                acct["contacts"][0]["is_primary"] = 1
            if abbr == "NWH":  # primary moved A -> B, the D-03 'primary_changed' system event
                a, b = acct["contacts"][0], acct["contacts"][1]
                when = self.rand_instant(-12, -8)
                a["is_primary"], b["is_primary"] = 0, 1
                a["updated_at"] = b["updated_at"] = when
                self.add_audit(when, "crm", cid, "contact", b["id"], "primary_changed",
                               old={"primary_contact_id": a["id"], "primary_contact": a["name"]},
                               new={"primary_contact_id": b["id"], "primary_contact": b["name"]})
            if abbr == "BRS":  # a contact update and a deleted contact
                c = acct["contacts"][3]
                when = self.rand_instant(-9, -4)
                self.add_audit(when, "crm", cid, "contact", c["id"], "updated", label=c["name"],
                               old={"role": "Market Data Analyst"}, new={"role": c["role"]})
                c["updated_at"] = when
                gone = uid("contact-deleted", 1)
                self.add_audit(self.rand_instant(-15, -10), "crm", cid, "contact", gone, "deleted",
                               old={"name": "Morgan Hale", "role": "Desk Support Manager"},
                               reason="Left the firm")

    # ------------------------------------------------------------------ operations
    def build_windows_upgrades(self) -> None:
        r = self.r
        # Three releases ~91 days apart; spacing mirrors the §21 fixture (DEV -> East +35d -> West +7d).
        # current: DEV T-23 (overdue if not done), East T+12 (inside 14d), West T+19 (Upcoming 15-30)
        releases = [
            # Version strings are deliberately fictional (not the §21 fixture values).
            ("prev", 2026, "Q3", -114, -79, -72, "7.1.4", "mock-cd-26.3", "mock-mfa-1.1", "mock-rules-41"),
            ("cur", 2026, "Q4", -23, 12, 19, "7.2.0", "mock-cd-26.4", "mock-mfa-1.2", "mock-rules-42"),
            ("next", 2027, "Q1", 68, 103, 110, "7.3.0", "mock-cd-27.1", "mock-mfa-1.3", "mock-rules-43"),
        ]
        mw = "Fri 19:00 NY - Sun 12:00 NY"
        self.rel: Dict[str, Dict[str, Any]] = {}
        for key, y, q, dev, east, west, apics, cdr, mfas, mfar in releases:
            row = dict(schedule_year=y, schedule_quarter=q, notification_date=d(dev - 21),
                       dev_upgrade_date=d(dev), east_prod_date=d(east), west_prod_date=d(west),
                       apics_version=apics, cd_rules_version=cdr, mfa_software_version=mfas,
                       mfa_rules_version=mfar, maintenance_window=mw,
                       source_url=None, source_sync_at=ts(-2, 11, 0), source_sync_method="mock",
                       source_fingerprint=hashlib.sha256(f"{y}{q}{apics}".encode()).hexdigest()[:32],
                       updated_at=ts(-2, 11, 0))
            self.t["quarterly_upgrade_windows"].append(row)
            self.rel[key] = dict(row=row, DEV=dev, East=east, West=west, apics=apics)
        prev_version = {"prev": "7.0.9", "cur": "7.1.4", "next": "7.2.0"}

        for abbr, acct in self.accounts.items():
            city, alt = acct["city"], acct["alt"]
            pattern = [("bpipe", city, "PROD", "East"), ("bpipe", alt, "PROD", "West"),
                       ("bpipe", "dev", "DEV", "DEV"), ("sapi", city, "PROD", "East"),
                       ("mfa", alt, "PROD", "West")][: acct["n_servers"]]
            for kind, loc, env, pol in pattern:
                name = f"{abbr.lower()}-{kind}-{loc}-{'02' if pol == 'West' else '01'}"
                acct["servers"].append(dict(name=name, env=env, pol=pol,
                                            location=LOCATIONS.get(loc, LOCATIONS[city]), kind=kind))
        overrides = {  # (abbr, release, polarity) -> (status, validation, waiting_on)
            ("BRS", "cur", "DEV"): ("In Progress", "Pending", "Client app team sign-off"),     # tier 1
            ("CPG", "cur", "DEV"): ("Validation Required", "Pending", None),                   # tier 1 (first tier wins)
            ("HFA", "prev", "East"): ("Exception", "Pending", "Hardware replacement"),         # tier 1
            ("NWH", "cur", "DEV"): ("Completed", "Pending", None),                             # tier 5
            ("MRA", "prev", "West"): ("Completed", "Failed", "Bloomberg engineering"),         # tier 5
            ("KMC", "cur", "DEV"): ("Completed", "Failed", "Client QA"),                       # tier 5
            ("OLP", "cur", "East"): ("Deferred", "Pending", "Client change freeze"),           # excluded
            ("SCS", "cur", "DEV"): ("Completed", "Not Required", None),                        # excluded
            ("NWH", "cur", "East"): ("Awaiting Client", "Pending", "Client to confirm change ticket"),
            ("TBF", "cur", "West"): ("Awaiting Client", "Pending", "Client network team"),
        }
        default_status = {"DEV": ("Completed", "Passed"), "East": ("Scheduled", "Pending"),
                          "West": ("Planned", "Pending")}
        for abbr, acct in self.accounts.items():
            cid = acct["id"]
            for s_i, srv in enumerate(acct["servers"]):
                plan = ["prev", "cur"] + (["next"] if srv["pol"] == "DEV" else [])
                for rk in plan:
                    rel = self.rel[rk]
                    off = rel[srv["pol"]]
                    if rk == "prev":
                        status, val = "Completed", "Passed"
                    elif rk == "next":
                        status, val = "Planned", "Pending"
                    else:
                        status, val = default_status[srv["pol"]]
                    waiting = None
                    key = (abbr, rk, srv["pol"])
                    if key in overrides and (s_i < 3):
                        status, val, waiting = overrides[key]
                    created = ts(rel["East"] - 50, 15, r.randint(0, 59), 0, r.randint(0, 999))
                    if created > LATEST_INSTANT:  # future release: planned recently, not "in the future"
                        created = self.rand_instant(-14, -2)
                    if status in ("Completed", "Validation Required", "In Progress", "Exception"):
                        updated = cap(ts(off + 1, 14, r.randint(0, 59)))
                    elif status == "Planned":
                        updated = created
                    else:
                        updated = self.rand_instant(-10, -1)
                    updated = max(updated, created)
                    if acct["row"]["status"] == "Inactive":
                        updated = created
                    row = dict(id=self.nid("server_upgrade"), client_id=cid, server_name=srv["name"],
                               environment=srv["env"], polarity=srv["pol"],
                               schedule_year=rel["row"]["schedule_year"], schedule_quarter=rel["row"]["schedule_quarter"],
                               current_version=prev_version[rk], target_version=rel["apics"],
                               scheduled_date=d(off), maintenance_window=rel["row"]["maintenance_window"],
                               status=status, validation_status=val, waiting_on=waiting,
                               reference=(f"{{DRQS {r.randint(100000000, 999999999)} <GO>}}"
                                          if status in ("Exception", "Validation Required") or val == "Failed" else None),
                               notes=None, source_url=None, created_at=created, updated_at=updated)
                    self.t["server_upgrades"].append(row)
                    snap = {"server_name": row["server_name"], "environment": row["environment"],
                            "polarity": row["polarity"], "scheduled_date": row["scheduled_date"],
                            "status": "Planned"}
                    self.add_audit(created, "operations", cid, "server_upgrade", row["id"], "created", new=snap)
                    if status != "Planned" and updated > created:
                        self.add_audit(updated, "operations", cid, "server_upgrade", row["id"], "updated", label=srv["name"],
                                       old={"status": "Planned"},
                                       new={"status": status, "validation_status": val})
        # Ad-hoc upgrade outside any release (NULL release): Upcoming 15-30 band.
        acct = self.accounts["TBF"]
        created = self.rand_instant(-8, -3)
        row = dict(id=self.nid("server_upgrade"), client_id=acct["id"], server_name="tbf-sapi-ny-01",
                   environment="PROD", polarity="East", schedule_year=None, schedule_quarter=None,
                   current_version="7.1.4", target_version="7.2.0-hotfix1", scheduled_date=d(26),
                   maintenance_window="Sat 08:00-12:00 NY", status="Scheduled", validation_status="Pending",
                   waiting_on=None, reference="{DRQS 418230771 <GO>}",
                   notes="Out-of-cycle hotfix requested by client.", source_url=None,
                   created_at=created, updated_at=created)
        self.t["server_upgrades"].append(row)
        self.add_audit(created, "operations", acct["id"], "server_upgrade", row["id"], "created",
                       new={"server_name": row["server_name"], "environment": "PROD", "polarity": "East",
                            "scheduled_date": row["scheduled_date"], "status": "Scheduled"})
        # D-24 scenarios (ad-hoc, no release):
        for abbr, server, off, status, val, waiting in [
            ("LHF", "lhf-sapi-ny-01", 45, "Exception", "Pending", "Hardware lead time"),   # tier 5 at any date
            ("SCS", "scs-sapi-ldn-01", 22, "Deferred", "Pending", "Client budget freeze"),  # Upcoming only
            ("MRA", "mra-sapi-chi-01", 5, "Deferred", "Failed", "Client postponed"),       # never queued
        ]:
            acct = self.accounts[abbr]
            created = self.rand_instant(-20, -6)
            updated = self.rand_instant(-5, -1)
            row = dict(id=self.nid("server_upgrade"), client_id=acct["id"], server_name=server,
                       environment="PROD", polarity="East", schedule_year=None, schedule_quarter=None,
                       current_version="7.1.4", target_version="7.2.0", scheduled_date=d(off),
                       maintenance_window="Sat 08:00-12:00 NY", status=status, validation_status=val,
                       waiting_on=waiting, reference=None, notes="Out-of-cycle upgrade.", source_url=None,
                       created_at=created, updated_at=updated)
            self.t["server_upgrades"].append(row)
            self.add_audit(created, "operations", acct["id"], "server_upgrade", row["id"], "created",
                           new={"server_name": server, "environment": "PROD", "polarity": "East",
                                "scheduled_date": row["scheduled_date"], "status": "Planned"})
            self.add_audit(updated, "operations", acct["id"], "server_upgrade", row["id"], "updated", label=server,
                           old={"status": "Planned"}, new={"status": status, "validation_status": val})

    # ------------------------------------------------------------------ BAMS
    def build_bams(self) -> None:
        r = self.r
        metric_defs = [("CPU", "CPU Utilization (%)", 20, 60), ("MEM", "Memory Utilization (%)", 40, 75),
                       ("DISK", "Disk Usage (%)", 30, 70), ("NET", "Network Throughput (Mbps)", 80, 400)]
        self.metric_idx: Dict[Tuple[str, int, str], Dict[str, Any]] = {}
        self.rule_idx: Dict[Tuple[str, int, str, str], Dict[str, Any]] = {}
        anchor_now = fmt_instant(ANCHOR_NOW)

        def freshness_age(abbr: str, o_i: int, code: str, disabled: bool) -> Optional[float]:
            """Seconds since last_received at ANCHOR_NOW; None = No Data."""
            if disabled or (abbr, o_i, code) == ("MRA", 1, "MEM"):
                return None                                    # No Data
            if abbr == "OLP" and o_i == 0:
                return 33 * 3600.0                             # Stale (matches the open stale alert)
            if abbr == "AVC":
                return 40 * 86400.0 + r.randint(0, 3600)       # Stale (inactive account)
            if abbr == "KMC" and o_i == 1:
                return float(r.randint(85, 115))               # Delayed
            return float(r.randint(10, 60))                    # Live
        for abbr, acct in self.accounts.items():
            if abbr in NO_BAMS:
                continue
            cid = acct["id"]
            prod = [s for s in acct["servers"] if s["env"] == "PROD"]
            objs = list(prod)
            if abbr == "CPG":
                objs.append(dict(name="cpg-mfa-ldn-03", env="PROD", pol="West", location=LOCATIONS["ldn"],
                                 kind="mfa", disabled=True))
            for o_i, srv in enumerate(objs):
                name = srv["name"].upper() if (abbr == "NWH" and o_i == 0) else srv["name"]  # case-variant on purpose
                created = self.rand_instant(-300, -200)
                obj = dict(id=self.nid("bams_object"), client_id=cid, name=name, region=acct["region"],
                           location=srv["location"], environment=srv["env"],
                           enabled=0 if srv.get("disabled") else 1, created_at=created, updated_at=created)
                self.t["bams_objects"].append(obj)
                self.add_audit(created, "bams", cid, "bams_object", obj["id"], "created",
                               new={"name": name, "region": obj["region"]})
                codes = ["CPU", "MEM", "DISK"] + (["NET"] if srv["kind"] == "bpipe" else [])
                for code, mname, lo, hi in metric_defs:
                    if code not in codes:
                        continue
                    cur = round(r.uniform(lo, hi), 1)
                    h30 = round(cur * r.uniform(1.05, 1.25), 1)
                    h60 = round(h30 * r.uniform(1.0, 1.1), 1)
                    h90 = round(h60 * r.uniform(1.0, 1.1), 1)
                    if code != "NET":
                        h30, h60, h90 = (min(x, 99.0) for x in (h30, h60, h90))
                    age = freshness_age(abbr, o_i, code, bool(srv.get("disabled")))
                    if age is None:
                        recv = src = None
                    else:
                        recv = add_minutes(anchor_now, -age / 60.0)
                        src = add_minutes(recv, -r.randint(200, 1500) / 60000.0)
                    m = dict(id=self.nid("bams_metric"), object_id=obj["id"], metric_name=mname,
                             ticker=f"MOCK.{abbr}.{name.upper()}.{code}", current_value=None if age is None else cur,
                             last_source_update=src, last_received=recv,
                             high_30=None if age is None else h30, high_30_date=None if age is None else d(-r.randint(2, 29)),
                             high_60=None if age is None else h60, high_60_date=None if age is None else d(-r.randint(30, 59)),
                             high_90=None if age is None else h90, high_90_date=None if age is None else d(-r.randint(60, 89)),
                             enabled=1, stale_after_seconds=120, stale_suppressed=0,
                             created_at=created, updated_at=created)  # updated_at = config edits only (QA-2-6)
                    self.t["bams_metrics"].append(m)
                    self.metric_idx[(abbr, o_i, code)] = m
                    rules = {"CPU": [("fixed_threshold", ">", 85.0, None, "Warning", 3, 15),
                                     ("fixed_threshold", ">", 95.0, None, "Critical", 2, 5)],
                             "MEM": [("fixed_threshold", ">", 90.0, None, "Warning", 3, 15)],
                             "DISK": [("fixed_threshold", ">", 85.0, None, "Warning", 1, 60),
                                      ("fixed_threshold", ">", 95.0, None, "Critical", 1, 30)],
                             "NET": [("pct_of_high", ">=", 90.0, "90d", "Info", 3, 30),
                                     ("exceeds_high", ">", None, "30d", "Warning", 2, 30)]}[code]
                    for rt, op, thr, ref, sev, cons, cool in rules:
                        rule = dict(id=self.nid("bams_alert_rule"), metric_id=m["id"], rule_type=rt, operator=op,
                                    threshold=thr, reference_period=ref, consecutive_updates=cons, severity=sev,
                                    cooldown_minutes=cool, enabled=1, breach_count=0, suppress_until_clear=0,
                                    created_at=created, updated_at=created)
                        self.t["bams_alert_rules"].append(rule)
                        self.rule_idx[(abbr, o_i, code, sev if rt != "exceeds_high" else "exceeds")] = rule

        def event(abbr: str, o_i: int, code: str, sev_key: str, status: str, opened: str,
                  value: float, recovered: Optional[str] = None, closed: Optional[str] = None,
                  note: Optional[str] = None, stale: bool = False) -> Dict[str, Any]:
            m = self.metric_idx[(abbr, o_i, code)]
            rule = None if stale else self.rule_idx[(abbr, o_i, code, sev_key)]
            sev = "Warning" if stale else rule["severity"]
            if stale:
                msg = "No source update for more than 120 s"
            elif rule["rule_type"] == "fixed_threshold":
                msg = f"{m['metric_name']} {rule['operator']} {rule['threshold']:g} (value {value:g})"
            elif rule["rule_type"] == "pct_of_high":
                msg = f"{m['metric_name']} at {rule['threshold']:g}% of {rule['reference_period']} high (value {value:g})"
            else:
                msg = f"{m['metric_name']} exceeded its {rule['reference_period']} high (value {value:g})"
            if stale:
                last_trig = None
            elif status == "open":
                last_trig = cap(add_minutes(opened, 37))
            elif recovered:
                last_trig = min(recovered, add_minutes(opened, 37))
            else:  # closed while still breaching
                last_trig = add_minutes(opened, 12)
            ev = dict(id=self.nid("bams_alert_event"), metric_id=m["id"], rule_id=None if stale else rule["id"],
                      alert_type="stale" if stale else rule["rule_type"], severity=sev, message=msg,
                      opened_at=opened, last_triggered_at=last_trig,
                      recovered_at=recovered, closed_at=closed, status=status,
                      current_value=value if status == "open" else round(value * 0.7, 1),
                      trigger_value=value, peak_value=round(value * 1.02, 1), closed_note=note,
                      created_at=opened, updated_at=max(x for x in (opened, recovered or opened, closed or opened)))
            self.t["bams_alert_events"].append(ev)
            if status == "open" and not stale:
                m["current_value"] = value
                rule["breach_count"] = rule["consecutive_updates"] + 2
                rule["updated_at"] = max(rule["updated_at"], opened)
            if status == "recovered":
                m["current_value"] = round(value * 0.7, 1)
            return ev

        scen = [  # active-account scenarios (Today tiers 1 and 3)
            event("HFA", 0, "CPU", "Critical", "open", ts(-1, 2, 10, 4, 211), 97.4),
            event("CPG", 0, "DISK", "Critical", "open", ts(-2, 22, 40, 9, 5), 96.3),
            event("NWH", 0, "DISK", "Warning", "open", ts(-3, 14, 5, 0, 330), 88.1),
            event("MRA", 0, "CPU", "Warning", "open", ts(-1, 1, 30, 2, 18), 89.6),
            event("KMC", 0, "NET", "Info", "open", ts(-2, 15, 20, 44, 902), 372.0),
            event("OLP", 0, "CPU", "", "open", ts(-1, 3, 5, 0, 0), 41.0, stale=True),
            event("BRS", 0, "CPU", "Warning", "recovered", ts(-4, 13, 0, 1, 1), 87.2, recovered=ts(-3, 16, 30, 0, 450)),
            event("TBF", 0, "CPU", "Critical", "recovered", ts(-2, 9, 0, 0, 77), 96.0, recovered=ts(-1, 2, 0, 0, 0)),
            # inactive account: must NOT appear in Today
            event("AVC", 0, "CPU", "Critical", "open", ts(-6, 4, 0, 0, 0), 98.2),
            # closed while still breaching -> rule suppressed until clear (§27)
            event("SCS", 0, "DISK", "Warning", "closed", ts(-3, 12, 0, 0, 0), 87.0, closed=ts(-2, 9, 15, 0, 0),
                  note="Known log growth; client is rotating logs this week."),
        ]
        self.rule_idx[("SCS", 0, "DISK", "Warning")]["suppress_until_clear"] = 1
        self.metric_idx[("SCS", 0, "DISK")]["current_value"] = 87.0
        # historical closed events
        keys = [k for k in self.rule_idx if k[0] not in ("AVC",)]
        keys.sort()
        for i in range(16):
            abbr, o_i, code, sev_key = keys[r.randrange(len(keys))]
            opened = ts(-r.randint(8, 80), r.randint(0, 20), r.randint(0, 59), r.randint(0, 59), r.randint(0, 999))
            rec = add_minutes(opened, r.randint(20, 300))
            clo = add_minutes(rec, r.randint(60, 1500))
            event(abbr, o_i, code, sev_key, "closed", opened, 90.0 + r.randint(0, 80) / 10, recovered=rec, closed=clo,
                  note=r.choice(["Transient load from EOD batch.", "Reviewed with client; no action needed.",
                                 "Client restarted the service.", "Expected during failover test."]))
        # notification log for the active (non-closed) events
        for ev in scen:
            if ev["status"] == "closed":
                continue
            for kind, at in (("opened", ev["opened_at"]), ("recovered", ev["recovered_at"])):
                if at is None:
                    continue
                for ch in ("in_app", "desktop"):
                    if ch == "desktop" and ev["severity"] == "Info":
                        continue
                    ok = not (ch == "desktop" and ev["severity"] == "Critical" and kind == "opened"
                              and ev is scen[1])
                    self.t["bams_notification_log"].append(dict(
                        id=len(self.t["bams_notification_log"]) + 1, event_id=ev["id"], kind=kind, channel=ch,
                        attempted_at=add_minutes(at, 0.05), success=1 if ok else 0,
                        detail=None if ok else "Desktop notification API unavailable (mock)"))
        # samples: 24 hourly samples ending at the last source update for scenario metrics + a few others
        sample_metrics = [self.metric_idx[k] for k in sorted(self.metric_idx)
                          if k[1] == 0 and k[2] in ("CPU", "DISK", "NET")][:24]
        for m in sample_metrics:
            for h in range(24, 0, -1):
                at = add_minutes(m["last_source_update"], -60 * (h - 1))
                v = max(0.0, round(m["current_value"] * r.uniform(0.85, 1.05), 1))
                if h == 1:
                    v = m["current_value"]
                self.t["bams_metric_samples"].append(dict(
                    id=len(self.t["bams_metric_samples"]) + 1, metric_id=m["id"], sampled_at=at,
                    source_update=add_minutes(at, -0.25), value=v))
        # starter alert configurations
        base = ts(-300, 12, 0)
        for name, match, rt, op, thr, ref, sev, cons, cool in [
            ("CPU above 85% (Warning)", "CPU*", "fixed_threshold", ">", 85.0, None, "Warning", 3, 15),
            ("CPU above 95% (Critical)", "CPU*", "fixed_threshold", ">", 95.0, None, "Critical", 2, 5),
            ("Disk above 85% (Warning)", "Disk*", "fixed_threshold", ">", 85.0, None, "Warning", 1, 60),
            ("Network at 90% of 90-day high (Info)", "Network*", "pct_of_high", ">=", 90.0, "90d", "Info", 3, 30),
            ("Network exceeds 30-day high (Warning)", "Network*", "exceeds_high", ">", None, "30d", "Warning", 2, 30),
        ]:
            self.t["bams_alert_configs"].append(dict(
                id=self.nid("bams_alert_config"), name=name, metric_match=match, rule_type=rt, operator=op,
                threshold=thr, reference_period=ref, consecutive_updates=cons, severity=sev,
                cooldown_minutes=cool, enabled=1, starter=1, created_at=base, updated_at=base))

    # ------------------------------------------------------------------ tasks
    def task(self, client: Optional[str], title: str, category: str, priority: str, status: str,
             due: Optional[int], next_update: Optional[int] = None, waiting: Optional[str] = None,
             archived: int = 0, notes: Optional[str] = None) -> Dict[str, Any]:
        r = self.r
        acct = self.accounts[client] if client else None
        cid = acct["id"] if acct else None
        anchor_off = due if due is not None else -r.randint(5, 40)
        created = self.rand_instant(min(anchor_off, 0) - r.randint(10, 45), min(anchor_off, 0) - 6)
        if status == "Complete" or archived:
            updated = self.rand_instant(max(int((parse_instant(created) - dt.datetime(ANCHOR.year, ANCHOR.month, ANCHOR.day)).days) + 1, -60), -1)
        else:
            updated = self.rand_instant(-5, -1)
        updated = max(updated, created)
        if acct and acct["row"]["status"] == "Inactive":  # dormant account: no recent activity
            created, updated = self.rand_instant(-400, -200), self.rand_instant(-199, -60)
        row = dict(id=self.nid("task"), task=title, client_id=cid, category=category, priority=priority,
                   due=d(due), next_update=d(next_update), status=status, waiting=waiting, notes=notes,
                   archived=archived, created_at=created, updated_at=updated)
        self.t["tasks"].append(row)
        cat = "crm"
        self.add_audit(created, cat, cid, "task", row["id"], "created",
                       new={"task": title, "status": "Not Started", "priority": priority, "due": row["due"]})
        if status == "Complete":
            when = add_minutes(updated, -120) if archived else updated
            when = max(when, created)
            self.add_audit(when, cat, cid, "task", row["id"], "completed", label=title,
                           old={"status": "In Progress"}, new={"status": "Complete"})
        elif status == "Waiting":
            self.add_audit(updated, cat, cid, "task", row["id"], "updated", label=title,
                           old={"status": "In Progress"}, new={"status": "Waiting", "waiting": waiting,
                                                                "next_update": row["next_update"]})
        if archived:
            self.add_audit(updated, cat, cid, "task", row["id"], "archived", label=title,
                           old={"archived": 0}, new={"archived": 1})
        return row

    def build_tasks(self) -> None:
        r = self.r
        T = self.task
        # --- scenario tasks: every Today tier + first-tier-wins + exclusions (comments = expected tier)
        T("NWH", "Send entitlement summary to desk heads", "Entitlements", "High", "In Progress", -3)          # 1
        T("MRA", "Confirm B-PIPE failover test window", "Engineering Follow-Up", "Medium", "Not Started", -1)  # 1
        T("CPG", "Collect server inventory for Q4 upgrade", "Client Follow-Up", "High", "Waiting", -5,
          next_update=-2, waiting="Client infrastructure team")                                               # 1 (not 4)
        T(None, "Update internal escalation runbook", "Internal", "Low", "Not Started", -4)                   # 1, no account
        T("HFA", "Chase RCA for Monday gap fills", "Escalation", "Low", "In Progress", -10)                  # 1
        T("NWH", "Prepare QBR usage review deck", "Usage Review", "High", "In Progress", 0)                  # 2
        T("BRS", "Send monthly usage report", "Reporting", "Medium", "Not Started", 0)                       # 2
        T("OLP", "Confirm onboarding attendee list", "Onboarding", "Low", "Not Started", 0)                  # 2
        T("KMC", "Get sign-off on entitlement change", "Entitlements", "Medium", "Waiting", 0,
          next_update=-1, waiting="Client procurement")                                                       # 2 (not 4)
        T("HFA", "Confirm DR test results with client", "Client Follow-Up", "Medium", "Waiting", 10,
          next_update=0, waiting="Client network team")                                                       # 4
        T("BRS", "Awaiting latency capture from client", "Engineering Follow-Up", "High", "Waiting", None,
          waiting="Client infrastructure team")                                                               # 4 (null next_update)
        T("TBF", "Pending API migration plan", "Client Follow-Up", "Medium", "Waiting", 7,
          next_update=-3, waiting="Client change board")                                                      # 4
        T("MRA", "Book capacity planning session", "Meeting", "High", "Not Started", 1)                      # 6
        T("CPG", "Review entitlement exceptions for risk desk", "Entitlements", "Medium", "In Progress", 2)  # 6
        T("LHF", "Walk new analysts through Terminal basics", "Onboarding", "Low", "Not Started", 3)         # 6
        T("SCS", "Confirm change ticket for West upgrade", "Client Follow-Up", "Medium", "Waiting", 3,
          next_update=2, waiting="Client change board")                                                       # 6 (waiting, future update)
        T("NWH", "Circulate pre-read for service review", "Meeting", "Medium", "Not Started", 6)            # upcoming (due)
        T("KMC", "Analyse peak-hour B-PIPE usage", "Usage Review", "Low", "In Progress", 12)                 # upcoming (due)
        T("TBF", "Awaiting vendor confirmation on feed", "Other", "Low", "Waiting", None, next_update=5,
          waiting="Market data vendor desk")                                                                  # upcoming (next_update)
        T("AVC", "Close out remaining entitlements", "Entitlements", "High", "Not Started", -2)              # excluded: Inactive
        T("NWH", "Old escalation tracker clean-up", "Other", "Medium", "In Progress", -6, archived=1)        # excluded: archived
        T("BRS", "Send Q3 incident summary", "Reporting", "Medium", "Complete", -2)                          # excluded: Complete
        T("CPG", "Plan 2027 capacity review", "Usage Review", "Low", "Not Started", 40)                      # beyond horizon
        T(None, "Prepare coverage handover notes", "Internal", "Medium", "Not Started", 8)                   # upcoming, no account
        T(None, "Refresh account list export", "Reporting", "Low", "Complete", -15, archived=1)              # archived, no account
        # D-23: follow-up task due == next_contact -> touch suppressed; different date -> both shown
        T("HFA", "Follow up with client on DR test results", "Client Follow-Up", "High", "Not Started", 0)  # tier 2, touch hidden
        T("BRS", "Follow up on Q4 upgrade timing", "Client Follow-Up", "Medium", "Not Started", 2)          # tier 6, touch hidden
        T("TBF", "Follow up on API migration plan", "Client Follow-Up", "Medium", "Not Started", 5)         # upcoming; touch (T-1) stays
        # one reopened task (task lifecycle event)
        reo = T("HFA", "Re-validate B-PIPE permissions after change", "Entitlements", "Medium", "In Progress", 9)
        self.add_audit(reo["updated_at"], "crm", reo["client_id"], "task", reo["id"], "reopened", label=reo["task"],
                       old={"status": "Complete"}, new={"status": "In Progress"})

        # --- filler: realistic mix, deterministic
        cats = list(CATEGORY_TITLES)
        statuses = ["Complete"] * 7 + ["Not Started"] * 4 + ["In Progress"] * 5 + ["Waiting"] * 4
        plan = [(abbr, 13 if a["row"]["status"] == "Active" else 2) for abbr, a in self.accounts.items()]
        plan.append((None, 6))
        for abbr, count in plan:
            acct = self.accounts.get(abbr) if abbr else None
            for _ in range(count):
                cat = r.choice(["Internal", "Reporting", "Other"]) if acct is None else r.choice(cats)
                topic = r.choice(TOPICS)
                server = r.choice(acct["servers"])["name"] if acct else "shared-tools"
                team = r.choice(ROLES)[1]
                title = r.choice(CATEGORY_TITLES[cat]).format(
                    topic=topic, server=server, team=team, ref=f"{{DRQS {r.randint(100000000, 999999999)} <GO>}}")
                status = r.choice(statuses) if (acct is None or acct["row"]["status"] == "Active") else "Complete"
                prio = r.choice(["High", "Medium", "Medium", "Low", "Low"])
                nxt, waiting = None, None
                roll = r.random()
                if status == "Complete":
                    due = None if roll < 0.2 else -r.randint(1, 90)
                elif roll < 0.18:
                    due = None
                elif roll < 0.26:
                    due = -r.randint(1, 20)
                elif roll < 0.30:
                    due = r.randint(0, 3)
                else:
                    due = r.randint(4, 60)
                if status == "Waiting":
                    waiting = r.choice(WAITING_ON + [c["name"] for c in (acct["contacts"] if acct else [])])
                    nxt = r.choice([None, -r.randint(1, 5), r.randint(1, 14), r.randint(1, 14)])
                archived = 1 if (status == "Complete" and r.random() < 0.18) else 0
                notes = r.choice([None, None, f"Context: {topic}. See {{DRQS {r.randint(100000000, 999999999)} <GO>}}.",
                                  "Client prefers email updates.\nCopy the desk head on replies."])
                T(abbr, title, cat, prio, status, due, nxt, waiting, archived, notes)
        # two deleted tasks (task lifecycle 'deleted' events; rows no longer exist)
        for i, (abbr, title) in enumerate([("NWH", "Duplicate: send entitlement summary"),
                                           ("KMC", "Test task created by mistake")], start=1):
            acct = self.accounts[abbr]
            self.add_audit(self.rand_instant(-20, -2), "crm", acct["id"], "task", uid("task-deleted", i), "deleted",
                           old={"task": title, "status": "Not Started"})

    # ------------------------------------------------------------------ notes
    def build_notes(self) -> None:
        r = self.r
        for abbr, acct in self.accounts.items():
            active = acct["row"]["status"] == "Active"
            count = 20 if active else 5
            lo, hi = (-150, -1) if active else (-420, -200)
            contacts = [c["name"] for c in acct["contacts"]] or ["the client"]
            servers = [s["name"] for s in acct["servers"]]
            latest_contact_day: Optional[str] = None
            for i in range(count):
                kind = r.choices(["Meeting Note", "Call Note", "General Note"], [35, 35, 30])[0]
                fill = dict(contact=r.choice(contacts), server=r.choice(servers), team=r.choice(ROLES)[1],
                            ref=f"{{DRQS {r.randint(100000000, 999999999)} <GO>}}")
                pool = {"Meeting Note": MEETING_SUBJECTS, "Call Note": CALL_SUBJECTS,
                        "General Note": GENERAL_SUBJECTS}[kind]
                subject = r.choice(pool).format(**fill)
                body = " ".join(f.format(**fill) for f in r.sample(BODY_FRAGMENTS, r.randint(2, 4)))
                if r.random() < 0.3:
                    body += "\n\n" + " ".join(f.format(**fill) for f in r.sample(BODY_FRAGMENTS, 2))
                items = None
                if (kind == "Meeting Note" and r.random() < 0.8) or (kind == "Call Note" and r.random() < 0.4):
                    items = "\n".join("- " + a.format(**fill) for a in r.sample(ACTION_FRAGMENTS, r.randint(1, 3)))
                stamp = self.rand_instant(lo, hi)
                created = cap(add_minutes(stamp, r.randint(5, 90)))  # stamp <= LATEST, so created >= stamp
                updated = created if r.random() < 0.8 else cap(add_minutes(created, r.randint(60, 2000)))
                source = "Migration" if (i < 2 and abbr in ("NWH", "HFA")) else "GUI"
                row = dict(id=self.nid("note"), client_id=acct["id"], note_type=kind, timestamp=stamp,
                           subject=subject, body=body, action_items=items, source=source,
                           created_at=created, updated_at=max(updated, created))
                self.t["notes"].append(row)
                self.add_audit(created, "crm", acct["id"], "note", row["id"], "created",
                               new={"note_type": kind, "subject": subject, "timestamp": stamp}, source=source)
                if updated > created:
                    self.add_audit(updated, "crm", acct["id"], "note", row["id"], "updated", label=subject,
                                   old={"body": "(previous text)"}, new={"body": "(edited)"})
                if kind in ("Meeting Note", "Call Note"):
                    day = stamp[:10]
                    if latest_contact_day is None or day > latest_contact_day:
                        latest_contact_day = day
                        latest_stamp = created
            # D-08: last_contact follows the latest Meeting/Call note (System-sourced audit)
            if latest_contact_day:
                acct["row"]["last_contact"] = latest_contact_day
                self.add_audit(latest_stamp, "crm", acct["id"], "client", acct["id"], "last_contact_changed",
                               label=acct["row"]["name"], reason="Meeting/Call note saved (D-08)",
                               new={"last_contact": latest_contact_day}, source="System")
                acct["row"]["updated_at"] = max(acct["row"]["updated_at"], latest_stamp)
        # deleted notes -> "Meeting note deleted: <subject>" system events
        for i, (abbr, kind, subj) in enumerate([
            ("NWH", "Meeting Note", "Draft: QBR agenda (duplicate)"), ("HFA", "Call Note", "Call notes entered on wrong account"),
            ("BRS", "General Note", "Scratch note"), ("CPG", "Meeting Note", "Test meeting note"),
            ("KMC", "Call Note", "Duplicate call log"), ("TBF", "General Note", "Outdated context"),
        ], start=1):
            acct = self.accounts[abbr]
            stamp = self.rand_instant(-30, -10)
            self.add_audit(self.rand_instant(-9, -1), "crm", acct["id"], "note", uid("note-deleted", i), "deleted",
                           old={"note_type": kind, "subject": subj, "timestamp": stamp})

    # ------------------------------------------------------------------ settings / backup audit
    def build_misc_audit(self) -> None:
        self.add_audit(ts(-20, 15, 0, 0, 120), "settings", None, "setting", "setting.auto_refresh_minutes", "updated",
                       label="setting.auto_refresh_minutes",
                       old={"value": "off"}, new={"value": "5"})
        self.add_audit(ts(-20, 15, 1, 0, 500), "settings", None, "setting", "setting.time_display", "updated",
                       label="setting.time_display",
                       old={"value": "gmt"}, new={"value": "local"})
        self.add_audit(ts(-7, 18, 30, 0, 0), "data", None, "backup", "tam_manual_backup.db", "created",
                       label="tam_manual_backup.db",
                       new={"reason": "manual"}, source="GUI")


def generate(path: Path = MOCK_JSON) -> Dict[str, Any]:
    data = Gen().build()
    # Stable, diff-friendly layout: header keys pretty-printed, one table row per line.
    row = lambda o: json.dumps(o, ensure_ascii=False, separators=(", ", ": "))  # noqa: E731
    parts = ["{"]
    for k in ("format", "anchor_date", "anchor_now", "generator", "notice", "rebase", "app_meta"):
        parts.append(f" {json.dumps(k)}: {json.dumps(data[k], ensure_ascii=False)},")
    parts.append(' "tables": {')
    tables = list(data["tables"].items())
    for ti, (name, rows) in enumerate(tables):
        body = ",\n".join("   " + row(r) for r in rows)
        parts.append(f'  {json.dumps(name)}: [' + ("\n" + body + "\n  ]" if rows else "]")
                     + ("," if ti < len(tables) - 1 else ""))
    parts.append(" }\n}\n")
    text = "\n".join(parts)
    assert json.loads(text) == json.loads(json.dumps(data)), "serializer round-trip mismatch"
    path.write_text(text, encoding="utf-8")
    return data

# ----------------------------------------------------------------------------- rebase + load

def default_now(today: dt.date) -> dt.datetime:
    """Load instant (naive UTC): real now when seeding for the real local today, else today 12:00Z."""
    if today == dt.date.today():
        return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    return dt.datetime(today.year, today.month, today.day, 12, 0, 0)


def rebase(data: Dict[str, Any], today: dt.date, now: Optional[dt.datetime] = None) -> Dict[str, List[Dict[str, Any]]]:
    anchor = dt.date.fromisoformat(data["anchor_date"])
    delta = dt.timedelta(days=(today - anchor).days)
    now = now or default_now(today)
    now_delta = now - parse_instant(data["anchor_now"])
    dq = qindex(today.year, f"Q{(today.month - 1) // 3 + 1}") - qindex(anchor.year, f"Q{(anchor.month - 1) // 3 + 1}")
    rb = data["rebase"]

    def sd(v: Optional[str]) -> Optional[str]:
        return None if v is None else (dt.date.fromisoformat(v) + delta).isoformat()

    def si(v: Optional[str]) -> Optional[str]:
        return None if v is None else fmt_instant(parse_instant(v) + delta)

    out: Dict[str, List[Dict[str, Any]]] = {}
    for table, rows in data["tables"].items():
        dates = rb["date_fields"].get(table, [])
        insts = rb["instant_fields"].get(table, [])
        nows = rb["now_relative_fields"].get(table, [])
        quarter = table in rb["quarter_fields"]
        jfields = rb["json_fields"].get(table, [])
        new_rows = []
        for row in rows:
            row = dict(row)
            for f in dates:
                row[f] = sd(row[f])
            for f in insts:
                row[f] = si(row[f])
            for f in nows:
                if row[f] is not None:
                    row[f] = fmt_instant(parse_instant(row[f]) + now_delta)
            if quarter and row.get("schedule_year") is not None:
                row["schedule_year"], row["schedule_quarter"] = qlabel(
                    qindex(row["schedule_year"], row["schedule_quarter"]) + dq)
            for f in jfields:
                if row[f] is not None:
                    obj = json.loads(row[f])
                    for k in rb["json_date_keys"]:
                        if isinstance(obj.get(k), str):
                            obj[k] = sd(obj[k])
                    for k in rb["json_instant_keys"]:
                        if isinstance(obj.get(k), str):
                            obj[k] = si(obj[k])
                    row[f] = jdump(obj)
            new_rows.append(row)
        out[table] = new_rows
    return out


class SeedRefused(RuntimeError):
    pass


def _assert_dev_target(conn: sqlite3.Connection) -> None:
    """Guard lives in load() itself, so /api/dev/reseed gets it too (QA-1-14a)."""
    for _seq, name, path in conn.execute("PRAGMA database_list").fetchall():
        if name == "main" and path and Path(path).name.lower() in PROD_DB_NAMES:
            raise SeedRefused(f"refusing to seed a PROD-named database: {path}")


def load(conn: sqlite3.Connection, data: Dict[str, Any], today: dt.date, reset: bool = False,
         now: Optional[dt.datetime] = None) -> Dict[str, int]:
    if data.get("format") != FORMAT:
        raise ValueError(f"unexpected mock format {data.get('format')!r}")
    _assert_dev_target(conn)
    # fresh DB -> schema v1; stamps/checks db.channel='dev' (refuses a 'prod' DB)
    migrate.migrate(conn, channel="dev")  # noqa: channel is required
    populated = sum(conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                    for t in ("clients", "tasks", "notes", "audit_events"))
    if populated and not reset:
        raise SeedRefused("target DB already contains data; pass --reset (backend: take a safety backup first)")
    now = now or default_now(today)
    rows = rebase(data, today, now)
    counts: Dict[str, int] = {}
    conn.execute("BEGIN IMMEDIATE")
    try:
        if reset:
            migrate.purge_audit_events(conn)  # transactional drop/delete/recreate of the guard (QA-1-4)
            for t in reversed(TABLE_ORDER):
                if t != "audit_events":
                    conn.execute(f"DELETE FROM {t}")
            conn.execute("DELETE FROM sqlite_sequence")
            conn.execute("DELETE FROM app_meta WHERE key IN ('db.mock_seed','bams.mock_clock')")  # settings KEPT
        for t in TABLE_ORDER:
            recs = rows.get(t, [])
            if not recs:
                counts[t] = 0
                continue
            cols = list(recs[0].keys())
            sql = f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})"
            conn.executemany(sql, [tuple(rec[c] for c in cols) for rec in recs])
            counts[t] = len(recs)
        for kv in data["app_meta"]:  # defaults only: never overwrite the user's DEV settings
            conn.execute("INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
                         (kv["key"], kv["value"]))
        conn.execute("INSERT INTO app_meta(key,value) VALUES('db.mock_seed',?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (json.dumps({"format": FORMAT, "anchor_date": data["anchor_date"],
                                  "rebased_to": today.isoformat(), "bams_now": fmt_instant(now),
                                  "loaded_at": migrate.utc_now()}),))
        # Frozen mock clock for BAMS freshness (QA-1-5): see queries/metric_freshness.sql
        conn.execute("INSERT INTO app_meta(key,value) VALUES('bams.mock_clock',?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (fmt_instant(now),))
        bad = conn.execute("PRAGMA foreign_key_check").fetchall()
        if bad:
            raise RuntimeError(f"foreign_key_check failed: {bad[:5]}")
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return counts

# ----------------------------------------------------------------------------- verify

def verify(conn: sqlite3.Connection, today: dt.date) -> bool:
    q = conn.execute
    ok_all = True

    def check(label: str, ok: bool, detail: Any = "") -> None:
        nonlocal ok_all
        ok_all &= bool(ok)
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail != "" else ""))

    print("PRAGMA integrity_check  ->", q("PRAGMA integrity_check").fetchone()[0])
    fk = q("PRAGMA foreign_key_check").fetchall()
    print("PRAGMA foreign_key_check ->", fk if fk else "[] (no violations)")
    check("integrity_check = ok", q("PRAGMA integrity_check").fetchone()[0] == "ok")
    check("foreign_key_check empty", not fk)

    print("\nRow counts:")
    for t in ["app_meta"] + TABLE_ORDER:
        print(f"  {t:28s} {q(f'SELECT count(*) FROM {t}').fetchone()[0]:5d}")

    sql = TODAY_SQL.read_text(encoding="utf-8")
    conn.row_factory = sqlite3.Row
    items = conn.execute(sql, {"today": today.isoformat()}).fetchall()
    conn.row_factory = None
    print(f"\nToday queue for {today.isoformat()}:")
    by_tier: Dict[Any, List[sqlite3.Row]] = {}
    for it in items:
        by_tier.setdefault(it["tier"] if it["section"] == "queue" else "upcoming", []).append(it)
    for tier in [1, 2, 3, 4, 5, 6, "upcoming"]:
        rows = by_tier.get(tier, [])
        kinds: Dict[str, int] = {}
        for it in rows:
            kinds[it["kind"]] = kinds.get(it["kind"], 0) + 1
        label = rows[0]["tier_label"] if rows and tier != "upcoming" else ("Upcoming panel" if tier == "upcoming" else "")
        print(f"  tier {tier!s:9s} {label:22s} {len(rows):3d}  {kinds}")
    print("\n  First 12 queue rows (ranked):")
    for it in [i for i in items if i["section"] == "queue"][:12]:
        print(f"    t{it['tier']} {it['urgency']:10s} {it['kind']:16s} {str(it['client_name'] or 'No account')[:28]:28s} "
              f"{str(it['priority'] or it['severity'] or ''):8s} {str(it['date'] or '-')[:10]} d={it['days_delta']} "
              f"{it['title'][:46]}")

    print("\nCoverage checks (PM spec §2.8, §3.1):")
    for tier in range(1, 7):
        check(f"tier {tier} has >= 2 items", len(by_tier.get(tier, [])) >= 2, len(by_tier.get(tier, [])))
    check("Upcoming panel has items", len(by_tier.get("upcoming", [])) >= 2, len(by_tier.get("upcoming", [])))
    keys = [(i["kind"], i["id"]) for i in items]
    check("each object appears once (first qualifying tier only)", len(keys) == len(set(keys)))
    t1 = by_tier.get(1, [])
    check("tier 1 contains an overdue task", any(i["kind"] == "task" for i in t1))
    check("tier 1 contains an open Critical BAMS alert", any(i["kind"] == "bams_alert" for i in t1))
    check("tier 1 contains an overdue upgrade", any(i["kind"] == "server_upgrade" for i in t1))
    check("tier 1 ranks Critical alerts first", t1 and t1[0]["kind"] == "bams_alert")
    check("Waiting+overdue task lands in tier 1, not 4",
          any(i["kind"] == "task" and i["status"] == "Waiting" for i in t1))
    check("Waiting+due-today task lands in tier 2, not 4",
          any(i["status"] == "Waiting" for i in by_tier.get(2, [])))
    check("tier 2 contains High, Medium and Low",
          {"High", "Medium", "Low"} <= {i["priority"] for i in by_tier.get(2, [])})
    check("tier 3 has open and recovered alerts",
          {"open", "recovered"} <= {i["status"] for i in by_tier.get(3, [])})
    check("tier 4 has waiting tasks and client follow-ups",
          {"task", "client_follow_up"} <= {i["kind"] for i in by_tier.get(4, [])})
    check("tier 5 has date-driven and validation items",
          {"upgrade", "validation"} <= {i["urgency"] for i in by_tier.get(5, [])})
    touch_ids = {i["client_id"] for i in items if i["kind"] == "client_follow_up"}
    dup = q("SELECT DISTINCT c.id FROM clients c JOIN tasks t ON t.client_id = c.id WHERE c.status='Active' "
            "AND t.archived=0 AND t.status<>'Complete' AND t.category='Client Follow-Up' AND t.due = c.next_contact").fetchall()
    dup_ids = {r[0] for r in dup}
    check("D-23: matching follow-up task suppresses the touch item", len(dup_ids) >= 2 and not (dup_ids & touch_ids),
          f"{len(dup_ids)} accounts")
    check("D-23: the matching task carries context 'Next Client Touch'",
          any(i["kind"] == "task" and i["context"] == "Next Client Touch" for i in items))
    tbf = q("SELECT id FROM clients WHERE name LIKE 'Tidewater%'").fetchone()[0]
    check("D-23: different dates -> touch AND follow-up task both shown",
          tbf in touch_ids and any(i["kind"] == "task" and i["client_id"] == tbf and i["title"].startswith("Follow up")
                                   for i in items))
    check("D-24: future Exception (> 14 days) is in tier 5",
          any(i["kind"] == "server_upgrade" and i["tier"] == 5 and i["status"] == "Exception"
              and (i["days_delta"] or 0) > 14 for i in items))
    check("D-24: no Deferred upgrade in the queue",
          not any(i["kind"] == "server_upgrade" and i["section"] == "queue" and i["status"] == "Deferred" for i in items))
    check("D-24: Deferred inside the Upcoming window is listed in Upcoming",
          any(i["kind"] == "server_upgrade" and i["section"] == "upcoming" and i["status"] == "Deferred" for i in items))
    check("unassigned task appears in queue", any(i["client_id"] is None for i in items if i["section"] == "queue"))
    inactive = {r[0] for r in q("SELECT id FROM clients WHERE status='Inactive'")}
    check("no Inactive-account item in Today", not any(i["client_id"] in inactive for i in items))
    archived = {r[0] for r in q("SELECT id FROM tasks WHERE archived=1")}
    check("no archived task in Today", not any(i["kind"] == "task" and i["id"] in archived for i in items))
    first_overdue = next(n for n, i in enumerate(items) if i["kind"] == "task" and i["urgency"] == "overdue")
    first_upcoming = next(n for n, i in enumerate(items) if i["kind"] == "task" and i["urgency"] == "upcoming")
    check("§52: overdue task ranks before upcoming task", first_overdue < first_upcoming)
    check("§52: near-term (<=14d) upgrade in queue",
          any(i["kind"] == "server_upgrade" and 0 <= (i["days_delta"] or -1) <= 14 for i in items if i["section"] == "queue"))

    T = today.isoformat()
    scalar = lambda s, *a: q(s, a).fetchone()[0]  # noqa: E731
    check("account with zero primary contacts (active)",
          scalar("SELECT count(*) FROM clients c WHERE status='Active' AND NOT EXISTS "
                 "(SELECT 1 FROM contacts WHERE client_id=c.id AND is_primary=1)") >= 1)
    check("active account with no BAMS objects",
          scalar("SELECT count(*) FROM clients c WHERE status='Active' AND NOT EXISTS "
                 "(SELECT 1 FROM bams_objects WHERE client_id=c.id)") >= 1)
    check("Inactive accounts present", scalar("SELECT count(*) FROM clients WHERE status='Inactive'") >= 1)
    check("archived tasks present", scalar("SELECT count(*) FROM tasks WHERE archived=1") >= 1)
    check("unassigned tasks present", scalar("SELECT count(*) FROM tasks WHERE client_id IS NULL") >= 1)
    check("150+ tasks", scalar("SELECT count(*) FROM tasks") >= 150, scalar("SELECT count(*) FROM tasks"))
    check("200+ notes", scalar("SELECT count(*) FROM notes") >= 200, scalar("SELECT count(*) FROM notes"))
    check("all task statuses/priorities/categories used",
          scalar("SELECT count(DISTINCT status) FROM tasks") == 4
          and scalar("SELECT count(DISTINCT priority) FROM tasks") == 3
          and scalar("SELECT count(DISTINCT category) FROM tasks") == 10)
    check("all three note types used", scalar("SELECT count(DISTINCT note_type) FROM notes") == 3)
    check("alerts: open, recovered, closed present",
          scalar("SELECT count(DISTINCT status) FROM bams_alert_events") == 3)
    check("open Critical alert present",
          scalar("SELECT count(*) FROM bams_alert_events WHERE status='open' AND severity='Critical'") >= 1)
    check("upgrade inside 14 days", scalar("SELECT count(*) FROM server_upgrades WHERE scheduled_date BETWEEN ? AND date(?,'+14 day')", T, T) >= 1)
    check("upgrade in 15-30 day band", scalar("SELECT count(*) FROM server_upgrades WHERE scheduled_date BETWEEN date(?,'+15 day') AND date(?,'+30 day')", T, T) >= 1)
    check("upgrade beyond 30 days", scalar("SELECT count(*) FROM server_upgrades WHERE scheduled_date > date(?,'+30 day')", T) >= 1)
    check("Validation Required upgrade", scalar("SELECT count(*) FROM server_upgrades WHERE status='Validation Required'") >= 1)
    check("Completed + Pending upgrade", scalar("SELECT count(*) FROM server_upgrades WHERE status='Completed' AND validation_status='Pending'") >= 1)
    check("all 8 upgrade statuses or a documented subset",
          scalar("SELECT count(DISTINCT status) FROM server_upgrades") >= 7,
          scalar("SELECT group_concat(DISTINCT status) FROM server_upgrades"))
    check("emails are *.example.com only",
          scalar("SELECT count(*) FROM contacts WHERE email IS NOT NULL AND email NOT LIKE '%.example.com' "
                 "AND email NOT LIKE '%@example.com'") == 0)
    check("no instant later than yesterday (nothing stamped in the future)",
          scalar("SELECT max(m) FROM (SELECT max(updated_at) m FROM tasks UNION ALL SELECT max(timestamp) FROM audit_events "
                 "UNION ALL SELECT max(timestamp) FROM notes UNION ALL SELECT max(updated_at) FROM server_upgrades "
                 "UNION ALL SELECT max(updated_at) FROM bams_alert_events UNION ALL SELECT max(updated_at) FROM clients)") < T)
    check("last_contact == latest meeting/call note date (D-08)",
          scalar("SELECT count(*) FROM clients c WHERE c.last_contact IS NOT (SELECT max(substr(timestamp,1,10)) "
                 "FROM notes n WHERE n.client_id=c.id AND n.note_type IN ('Meeting Note','Call Note'))") == 0)
    stamp = json.loads(scalar("SELECT value FROM app_meta WHERE key='db.mock_seed'"))
    check("bams.mock_clock == db.mock_seed.bams_now",
          scalar("SELECT value FROM app_meta WHERE key='bams.mock_clock'") == stamp["bams_now"])
    fresh_sql = FRESHNESS_SQL.read_text(encoding="utf-8")
    wall = migrate.utc_now()  # REAL elapsed time since load (QA-1-5)
    states: Dict[str, int] = {}
    for r in q(fresh_sql, {"wall_now": wall, "provider_running": 0, "channel": "dev"}).fetchall():
        states[r[-1]] = states.get(r[-1], 0) + 1
    print(f"\nBAMS freshness at real wall time {wall} (frozen mock clock rule): {states}")
    for band in ("Live", "Delayed", "Stale", "No Data"):
        check(f"BAMS freshness state present under real time: {band}", states.get(band, 0) >= 1, states.get(band, 0))
    check("no BAMS reading in the future", scalar(
        f"SELECT count(*) FROM bams_metrics WHERE last_received > '{stamp['bams_now']}'") == 0)
    check("updated_at >= created_at for every seeded entity row", sum(
        scalar(f"SELECT count(*) FROM {t} WHERE updated_at < created_at") for t in ROW_VERSION_TABLES
        if t != "quarterly_upgrade_windows") == 0)
    check("row_version >= 1 on every entity row", sum(
        scalar(f"SELECT count(*) FROM {t} WHERE row_version < 1") for t in ROW_VERSION_TABLES) == 0)
    check("db.channel stamped 'dev'", scalar("SELECT value FROM app_meta WHERE key='db.channel'") == "dev")
    check("every audit row carries an object_label",
          scalar("SELECT count(*) FROM audit_events WHERE object_label IS NULL") == 0)
    check("upgrade scheduled_date matches its release + polarity",
          scalar("SELECT count(*) FROM server_upgrades u JOIN quarterly_upgrade_windows w USING (schedule_year, schedule_quarter) "
                 "WHERE u.scheduled_date IS NOT CASE u.polarity WHEN 'DEV' THEN w.dev_upgrade_date "
                 "WHEN 'East' THEN w.east_prod_date ELSE w.west_prod_date END") == 0)
    return bool(ok_all)

# ----------------------------------------------------------------------------- CLI

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="TAM Command Center mock seed (DEV only)")
    ap.add_argument("command", choices=["generate", "load", "verify", "all"])
    ap.add_argument("--db", type=Path)
    ap.add_argument("--today", type=dt.date.fromisoformat, default=None,
                    help="override 'today' (local date). Default: workstation local date (D-06)")
    ap.add_argument("--reset", action="store_true", help="wipe existing rows first (DEV reseed)")
    args = ap.parse_args(argv)
    today = args.today or dt.date.today()

    if args.command in ("generate", "all"):
        data = generate()
        n = {k: len(v) for k, v in data["tables"].items()}
        print(f"wrote {MOCK_JSON} ({MOCK_JSON.stat().st_size:,} bytes) sha256="
              f"{hashlib.sha256(MOCK_JSON.read_bytes()).hexdigest()[:16]}… rows={n}")
        if args.command == "generate":
            return 0
    if not args.db:
        ap.error("--db is required")
    if args.db.name.lower() in PROD_DB_NAMES:  # CLI pre-check so not even an empty file is created
        print(f"refused: refusing to seed a PROD-named database: {args.db}", file=sys.stderr)
        return 1
    args.db.parent.mkdir(parents=True, exist_ok=True)
    conn = migrate.connect(args.db)
    try:
        if args.command in ("load", "all"):
            data = json.loads(MOCK_JSON.read_text(encoding="utf-8"))
            try:
                counts = load(conn, data, today, reset=args.reset)
            except (SeedRefused, migrate.MigrationError) as exc:
                print(f"refused: {exc}", file=sys.stderr)
                return 1
            print(f"loaded into {args.db} rebased to {today}: {counts}")
        if args.command in ("verify", "all"):
            ok = verify(conn, today)
            print("\nVERIFY:", "PASS" if ok else "FAIL")
            return 0 if ok else 1
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

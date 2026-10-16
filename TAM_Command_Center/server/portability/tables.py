"""The eight exported data tables (D-123): sheet names, column headers (which double as CSV header signatures,
D-135), kinds, limits and parent links. One definition drives the exporter, the CSV table detection and the restore
planner. Table and column names here are fixed strings, never request input."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

STATUS_CLIENT = ("Active", "Inactive")
CATEGORIES = ("Client Follow-Up", "Engineering Follow-Up", "Reporting", "Internal", "Escalation", "Onboarding",
              "Entitlements", "Usage Review", "Meeting", "Other")
PRIORITIES = ("High", "Medium", "Low")
TASK_STATUSES = ("Not Started", "In Progress", "Waiting", "Complete")
NOTE_TYPES = ("Meeting Note", "Call Note", "General Note")
NOTE_SOURCES = ("GUI", "Migration", "Bulk Import", "ChatGPT Bridge")
ENVS = ("PROD", "DEV")
POLARITIES = ("East", "West", "DEV")
UPGRADE_STATUSES = ("Planned", "Awaiting Client", "Scheduled", "In Progress", "Validation Required", "Completed",
                    "Deferred", "Exception")
VALIDATION = ("Pending", "Passed", "Failed", "Not Required")
QUARTERS = ("Q1", "Q2", "Q3", "Q4")
SYNC_METHODS = ("live", "bundled_fallback", "manual", "mock")


@dataclass(frozen=True)
class Col:
    header: str
    db: Optional[str]                  # None = display-only column, ignored on restore
    kind: str = "text"                 # text | int | bool | date | instant
    required: bool = False             # must be present as a header (CSV signature) and non-blank
    default: object = None             # used when the cell is blank (NOT NULL columns with a DB default)
    maxlen: Optional[int] = None
    choices: Optional[Tuple[str, ...]] = None
    minv: Optional[int] = None
    maxv: Optional[int] = None


def _std() -> List[Col]:
    return [Col("row_version", None, "int"), Col("created_at", "created_at", "instant"), Col("updated_at", "updated_at", "instant")]


@dataclass(frozen=True)
class Table:
    key: str
    sheet: str
    db: str
    cols: List[Col]
    id_cols: Tuple[str, ...]                          # db columns forming the identity
    parents: Tuple[Tuple[str, str, str], ...] = ()    # (fk db column, parent table key, parent hint)
    label: str = ""
    order_by: str = "rowid"

    @property
    def data_cols(self) -> List[Col]:
        return [c for c in self.cols if c.db]

    def by_header(self) -> Dict[str, Col]:
        return {c.header.casefold(): c for c in self.cols}

    @property
    def required_headers(self) -> List[str]:
        return [c.header for c in self.cols if c.required]


TABLES: List[Table] = [
    Table("accounts", "Accounts", "clients", [
        Col("id", "id", required=True, maxlen=64),
        Col("name", "name", required=True, maxlen=200),
        Col("status", "status", default="Active", choices=STATUS_CLIENT),
        Col("bpid", "bpid", maxlen=32), Col("products", "products", maxlen=500),
        Col("contact", "contact", maxlen=500),
        Col("last_contact", "last_contact", "date"), Col("next_contact", "next_contact", "date"),
        Col("notes", "notes", maxlen=20000)] + _std(), ("id",), label="Accounts"),
    Table("contacts", "Contacts", "contacts", [
        Col("id", "id", required=True, maxlen=64),
        Col("client_id", "client_id", required=True, maxlen=64), Col("account_name", None),
        Col("name", "name", required=True, maxlen=200),
        Col("role", "role", maxlen=200), Col("email", "email", maxlen=254), Col("team", "team", maxlen=200),
        Col("is_primary", "is_primary", "bool", default=0)] + _std(), ("id",),
        (("client_id", "accounts", "Add the Accounts file"),), label="Contacts"),
    Table("tasks", "Tasks", "tasks", [
        Col("id", "id", required=True, maxlen=64), Col("task", "task", required=True, maxlen=500),
        Col("client_id", "client_id", maxlen=64), Col("account_name", None),
        Col("category", "category", default="Other", choices=CATEGORIES),
        Col("priority", "priority", default="Medium", choices=PRIORITIES),
        Col("due", "due", "date"), Col("next_update", "next_update", "date"),
        Col("status", "status", default="Not Started", choices=TASK_STATUSES),
        Col("waiting", "waiting", maxlen=500), Col("notes", "notes", maxlen=20000),
        Col("archived", "archived", "bool", default=0)] + _std(), ("id",),
        (("client_id", "accounts", "Add the Accounts file"),), label="Tasks"),
    Table("notes", "Notes", "notes", [
        Col("id", "id", required=True, maxlen=64),
        Col("client_id", "client_id", required=True, maxlen=64), Col("account_name", None),
        Col("note_type", "note_type", required=True, choices=NOTE_TYPES),
        Col("timestamp", "timestamp", "instant", required=True),
        Col("subject", "subject", maxlen=200), Col("body", "body", maxlen=50000),
        Col("action_items", "action_items", maxlen=10000),
        Col("source", "source", default="GUI", choices=NOTE_SOURCES)] + _std(), ("id",),
        (("client_id", "accounts", "Add the Accounts file"),), label="Notes"),
    Table("appliances", "Appliances", "bams_objects", [
        Col("id", "id", required=True, maxlen=64),
        Col("client_id", "client_id", required=True, maxlen=64), Col("account_name", None),
        Col("name", "name", required=True, maxlen=200),
        Col("region", "region", maxlen=100), Col("location", "location", maxlen=200),
        Col("environment", "environment", choices=ENVS), Col("enabled", "enabled", "bool", default=1)] + _std(),
        ("id",), (("client_id", "accounts", "Add the Accounts file"),), label="Appliances"),
    Table("metrics", "Metrics", "bams_metrics", [
        Col("id", "id", required=True, maxlen=64),
        Col("object_id", "object_id", required=True, maxlen=64), Col("appliance_name", None), Col("account_name", None),
        Col("metric_name", "metric_name", required=True, maxlen=200), Col("ticker", "ticker", required=True, maxlen=200),
        Col("stale_after_seconds", "stale_after_seconds", "int", default=120, minv=1, maxv=31536000),
        Col("enabled", "enabled", "bool", default=1), Col("stale_suppressed", "stale_suppressed", "bool", default=0)] + _std(), ("id",),
        (("object_id", "appliances", "Add the Appliances file"),), label="Metrics"),
    Table("quarters", "Operations Quarters", "quarterly_upgrade_windows", [
        Col("schedule_year", "schedule_year", "int", required=True, minv=2000, maxv=2100),
        Col("schedule_quarter", "schedule_quarter", required=True, choices=QUARTERS),
        Col("apics_version", "apics_version", maxlen=50),
        Col("dev_upgrade_date", "dev_upgrade_date", "date"), Col("east_prod_date", "east_prod_date", "date"),
        Col("west_prod_date", "west_prod_date", "date"), Col("notification_date", "notification_date", "date"),
        Col("cd_rules_version", "cd_rules_version", maxlen=50), Col("mfa_software_version", "mfa_software_version", maxlen=50),
        Col("mfa_rules_version", "mfa_rules_version", maxlen=50), Col("maintenance_window", "maintenance_window", maxlen=200), Col("source_url", "source_url", maxlen=2000),
        Col("source_sync_method", "source_sync_method", choices=SYNC_METHODS),
        Col("row_version", None, "int"), Col("updated_at", "updated_at", "instant")],
        ("schedule_year", "schedule_quarter"), label="Operations Quarters", order_by="schedule_year, schedule_quarter"),
    Table("records", "Operations Records", "server_upgrades", [
        Col("id", "id", required=True, maxlen=64),
        Col("client_id", "client_id", required=True, maxlen=64), Col("account_name", None),
        Col("server_name", "server_name", required=True, maxlen=200),
        Col("environment", "environment", required=True, choices=ENVS),
        Col("polarity", "polarity", required=True, choices=POLARITIES),
        Col("schedule_year", "schedule_year", "int", minv=2000, maxv=2100), Col("schedule_quarter", "schedule_quarter", choices=QUARTERS),
        Col("current_version", "current_version", maxlen=50), Col("target_version", "target_version", maxlen=50),
        Col("scheduled_date", "scheduled_date", "date"), Col("maintenance_window", "maintenance_window", maxlen=200),
        Col("status", "status", default="Planned", choices=UPGRADE_STATUSES),
        Col("validation_status", "validation_status", default="Pending", choices=VALIDATION),
        Col("waiting_on", "waiting_on", maxlen=500), Col("reference", "reference", maxlen=200),
        Col("notes", "notes", maxlen=20000), Col("source_url", "source_url", maxlen=2000)] + _std(), ("id",),
        (("client_id", "accounts", "Add the Accounts file"), ("*window", "quarters", "Add the Operations Quarters file")),
        label="Operations Records"),
]
BY_KEY: Dict[str, Table] = {t.key: t for t in TABLES}
BY_SHEET: Dict[str, Table] = {t.sheet.casefold(): t for t in TABLES}
ABOUT_SHEET = "About"
APP_NAME = "TAM Command Center"

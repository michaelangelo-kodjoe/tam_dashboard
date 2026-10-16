"""Deterministic generator for the Run 6 portability fixtures (T-175).

Run: python build_fixtures.py   (rewrites the files next to this script)
Column sets are the SPEC §14 (D-123) sheet columns: row id, parent id and
parent name, row_version, then the table columns. The BE contract (T-174) may
rename headers; keep SHEETS here as the single source for fixtures.
Fictional data only (example.test addresses).
"""
import csv
from pathlib import Path

HERE = Path(__file__).resolve().parent
TS = "2026-09-01T10:00:00.000Z"
TAIL = ["row_version", "created_at", "updated_at"]

SHEETS = {  # sheet name -> (db table, columns)
    "Accounts": ("clients", ["id", "name", "status", "bpid", "products", "contact",
                             "last_contact", "next_contact", "notes"] + TAIL),
    "Contacts": ("contacts", ["id", "client_id", "account_name", "name", "role", "email",
                              "team", "is_primary"] + TAIL),
    "Tasks": ("tasks", ["id", "client_id", "account_name", "task", "category", "priority", "due",
                        "next_update", "status", "waiting", "notes", "archived"] + TAIL),
    "Notes": ("notes", ["id", "client_id", "account_name", "note_type", "timestamp", "subject",
                        "body", "action_items", "source"] + TAIL),
    "Appliances": ("bams_objects", ["id", "client_id", "account_name", "name", "region",
                                    "location", "environment", "enabled"] + TAIL),
    "Metrics": ("bams_metrics", ["id", "object_id", "appliance_name", "account_name",
                                 "metric_name", "ticker", "enabled", "stale_after_seconds",
                                 "stale_suppressed"] + TAIL),
    "Operations Quarters": ("quarterly_upgrade_windows", [
        "schedule_year", "schedule_quarter", "notification_date", "dev_upgrade_date",
        "east_prod_date", "west_prod_date", "apics_version", "cd_rules_version",
        "mfa_software_version", "mfa_rules_version", "maintenance_window", "source_url",
        "row_version", "updated_at"]),
    "Operations Records": ("server_upgrades", [
        "id", "client_id", "account_name", "server_name", "environment", "polarity",
        "schedule_year", "schedule_quarter", "current_version", "target_version",
        "scheduled_date", "maintenance_window", "status", "validation_status", "waiting_on",
        "reference", "notes", "source_url"] + TAIL),
}

def row(sheet, **kw):
    cols = SHEETS[sheet][1]
    d = {c: "" for c in cols}
    for t in TAIL:
        if t in d:
            d[t] = {"row_version": "1"}.get(t, TS)
    d.update({k: str(v) for k, v in kw.items()})
    return d

VALID = {
    "Accounts": [
        row("Accounts", id="fx-acc-1", name="Fixture Capital One", status="Active", next_contact="2026-10-20"),
        row("Accounts", id="fx-acc-2", name="Fixture Markets Two", status="Inactive", bpid="FX2")],
    "Contacts": [
        row("Contacts", id="fx-con-1", client_id="fx-acc-1", account_name="Fixture Capital One",
            name="Pat Example", email="pat@example.test", is_primary=1),
        row("Contacts", id="fx-con-2", client_id="fx-acc-1", account_name="Fixture Capital One",
            name="Sam Example", is_primary=0),
        row("Contacts", id="fx-con-3", client_id="fx-acc-2", account_name="Fixture Markets Two",
            name="Lee Example", is_primary=1)],
    "Tasks": [
        row("Tasks", id="fx-tsk-1", client_id="fx-acc-1", account_name="Fixture Capital One",
            task="Send usage report", category="Reporting", priority="High", due="2026-10-16",
            status="In Progress", archived=0),
        row("Tasks", id="fx-tsk-2", task="Internal housekeeping", category="Internal",
            priority="Low", status="Not Started", archived=0),
        row("Tasks", id="fx-tsk-3", client_id="fx-acc-2", account_name="Fixture Markets Two",
            task="=Formula-looking title is data", category="Other", priority="Medium",
            status="Waiting", waiting="Client reply", archived=0)],
    "Notes": [
        row("Notes", id="fx-not-1", client_id="fx-acc-1", account_name="Fixture Capital One",
            note_type="Meeting Note", timestamp="2026-09-30T14:00:00.000Z", subject="Quarterly sync",
            body="Discussed roadmap.", source="GUI")],
    "Appliances": [
        row("Appliances", id="fx-app-1", client_id="fx-acc-1", account_name="Fixture Capital One",
            name="FX-APP-A", region="US-East", environment="PROD", enabled=1)],
    "Metrics": [
        row("Metrics", id="fx-met-1", object_id="fx-app-1", appliance_name="FX-APP-A",
            account_name="Fixture Capital One", metric_name="Queue depth", ticker="FX TEST 1 Index",
            enabled=1, stale_after_seconds=120, stale_suppressed=0)],
    "Operations Quarters": [
        row("Operations Quarters", schedule_year=2026, schedule_quarter="Q4",
            notification_date="2026-10-01", east_prod_date="2026-11-14", apics_version="9.9")],
    "Operations Records": [
        row("Operations Records", id="fx-ops-1", client_id="fx-acc-1", account_name="Fixture Capital One",
            server_name="fx-srv-01", environment="PROD", polarity="East", schedule_year=2026,
            schedule_quarter="Q4", status="Planned", validation_status="Pending")],
}

def write_csv(path, cols, rows, delimiter=",", encoding="utf-8"):
    with open(path, "w", newline="", encoding=encoding) as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=delimiter)
        w.writeheader()
        w.writerows(rows)

def main():
    valid = HERE / "valid"
    invalid = HERE / "invalid"
    valid.mkdir(exist_ok=True)
    invalid.mkdir(exist_ok=True)
    for sheet, rows in VALID.items():
        write_csv(valid / f"{sheet.replace(' ', '_')}.csv", SHEETS[sheet][1], rows)
    # Variants of one table: semicolon, BOM, Windows-1252, shuffled columns.
    acc = SHEETS["Accounts"][1]
    write_csv(HERE / "variants_Accounts_semicolon.csv", acc, VALID["Accounts"], delimiter=";")
    write_csv(HERE / "variants_Accounts_bom.csv", acc, VALID["Accounts"], encoding="utf-8-sig")
    write_csv(HERE / "variants_Accounts_shuffled.csv", list(reversed(acc)), VALID["Accounts"])
    # Invalid files.
    write_csv(invalid / "Unrecognized.csv", ["alpha", "beta", "gamma"], [{"alpha": "1", "beta": "2", "gamma": "3"}])
    write_csv(invalid / "missing_parent_Contacts.csv", SHEETS["Contacts"][1], [
        row("Contacts", id="fx-con-orphan", client_id="fx-acc-GONE", account_name="Nowhere Inc",
            name="Orphan Example", is_primary=0)])
    write_csv(invalid / "missing_parent_Tasks.csv", SHEETS["Tasks"][1], [
        row("Tasks", id="fx-tsk-orphan", client_id="fx-acc-GONE", task="Orphan task",
            category="Other", priority="Low", status="Not Started", archived=0)])
    write_csv(invalid / "bad_values_Tasks.csv", SHEETS["Tasks"][1], [
        row("Tasks", id="fx-tsk-bad1", task="Bad status", category="Other", priority="Medium",
            status="Done-ish", archived=0),
        row("Tasks", id="fx-tsk-bad2", task="Bad priority", category="Other", priority="Urgent",
            status="Not Started", archived=0)])
    write_csv(invalid / "two_primaries_Contacts.csv", SHEETS["Contacts"][1], [
        row("Contacts", id="fx-con-p1", client_id="fx-acc-1", name="One", is_primary=1),
        row("Contacts", id="fx-con-p2", client_id="fx-acc-1", name="Two", is_primary=1)])
    write_csv(invalid / "dup_name_Accounts.csv", acc, [
        row("Accounts", id="fx-acc-9", name="fixture capital one", status="Active")])
    write_csv(invalid / "dup_ticker_Metrics.csv", SHEETS["Metrics"][1], [
        row("Metrics", id="fx-met-9", object_id="fx-app-1", metric_name="Other", ticker="FX TEST 1 Index",
            enabled=1, stale_after_seconds=120, stale_suppressed=0)])
    # xlsx: valid export-shaped workbook, DEV-channel workbook, newer-schema workbook, non-export workbook.
    try:
        import openpyxl
    except ImportError:
        print("openpyxl missing: xlsx fixtures skipped")
        return
    def book(path, channel="DEV", schema="1", with_about=True):
        wb = openpyxl.Workbook()
        ws = wb.active
        if with_about:
            ws.title = "About"
            ws.append(["key", "value"])
            for k, v in [("app", "TAM Command Center"), ("schema_version", schema), ("channel", channel)]:
                ws.append([k, v])
        else:
            ws.title = "Sheet1"
            ws.append(["not", "an", "export"])
        if with_about:
            for sheet, rows in VALID.items():
                w = wb.create_sheet(sheet)
                cols = SHEETS[sheet][1]
                w.append(cols)
                for r in rows:
                    w.append([r[c] for c in cols])
        wb.save(path)
    xl = HERE / "xlsx"
    xl.mkdir(exist_ok=True)
    book(xl / "valid_export_dev.xlsx", "DEV")
    book(xl / "valid_export_prod.xlsx", "PROD")
    book(xl / "newer_schema.xlsx", "PROD", schema="999")
    book(xl / "not_an_export.xlsx", with_about=False)

if __name__ == "__main__":
    main()

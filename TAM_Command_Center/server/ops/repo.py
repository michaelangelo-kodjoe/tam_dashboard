"""All Operations SQL. Parameterised only; identifiers are fixed strings, never input."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional

QCOLS = ("schedule_year, schedule_quarter, apics_version, dev_upgrade_date, east_prod_date, west_prod_date, row_version")


def _d(r: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(r) if r is not None else None


def quarters(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        f"SELECT {QCOLS}, (SELECT count(*) FROM server_upgrades s WHERE s.schedule_year = w.schedule_year"  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
        " AND s.schedule_quarter = w.schedule_quarter AND EXISTS (SELECT 1 FROM bams_objects o"
        " WHERE o.client_id = s.client_id AND o.name = s.server_name)) AS records FROM quarterly_upgrade_windows w"
        " ORDER BY schedule_year, schedule_quarter")]


def quarter(conn: sqlite3.Connection, year: int, q: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute(f"SELECT {QCOLS} FROM quarterly_upgrade_windows WHERE schedule_year = :y AND schedule_quarter = :q",  # nosec B608 - fixed identifiers/placeholders only, values are bound parameters
                           {"y": year, "q": q}).fetchone())


def record_count(conn: sqlite3.Connection, year: int, q: str) -> int:
    """Records that still match an appliance (QA-6-1); orphans (appliance renamed/deleted) are not counted."""
    return conn.execute("SELECT count(*) FROM server_upgrades s WHERE s.schedule_year = :y AND s.schedule_quarter = :q"
                        " AND EXISTS (SELECT 1 FROM bams_objects o WHERE o.client_id = s.client_id AND o.name = s.server_name)",
                        {"y": year, "q": q}).fetchone()[0]


def orphan_records(conn: sqlite3.Connection, year: int, q: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT s.* FROM server_upgrades s WHERE s.schedule_year = :y AND s.schedule_quarter = :q"
        " AND NOT EXISTS (SELECT 1 FROM bams_objects o WHERE o.client_id = s.client_id AND o.name = s.server_name)",
        {"y": year, "q": q})]


def insert_quarter(conn: sqlite3.Connection, v: Dict[str, Any], now: str) -> None:
    conn.execute("INSERT INTO quarterly_upgrade_windows (schedule_year, schedule_quarter, apics_version, dev_upgrade_date,"
                 " east_prod_date, west_prod_date, source_sync_method, updated_at)"
                 " VALUES (:year, :quarter, :apics_version, :dev_upgrade_date, :east_prod_date, :west_prod_date, 'manual', :now)",
                 {**v, "now": now})


def update_quarter(conn: sqlite3.Connection, year: int, q: str, v: Dict[str, Any], now: str) -> None:
    conn.execute("UPDATE quarterly_upgrade_windows SET apics_version = :apics_version, dev_upgrade_date = :dev_upgrade_date,"
                 " east_prod_date = :east_prod_date, west_prod_date = :west_prod_date, updated_at = :now,"
                 " row_version = row_version + 1 WHERE schedule_year = :y AND schedule_quarter = :q",
                 {**v, "now": now, "y": year, "q": q})


def delete_quarter(conn: sqlite3.Connection, year: int, q: str) -> int:
    return conn.execute("DELETE FROM quarterly_upgrade_windows WHERE schedule_year = :y AND schedule_quarter = :q",
                        {"y": year, "q": q}).rowcount


APPLIANCE_SQL = ("SELECT o.id AS object_id, o.client_id, c.name AS client_name, o.name AS appliance, o.region, o.environment,"
                 " o.enabled, o.row_version AS object_row_version FROM bams_objects o JOIN clients c ON c.id = o.client_id")


def appliances(conn: sqlite3.Connection, object_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    if object_ids is None:
        return [dict(r) for r in conn.execute(APPLIANCE_SQL)]
    out: List[Dict[str, Any]] = []
    for oid in object_ids:      # <= 500 single-row lookups; keeps the SQL free of generated placeholders
        r = conn.execute(APPLIANCE_SQL + " WHERE o.id = :i", {"i": oid}).fetchone()
        if r is not None:
            out.append(dict(r))
    return out


def appliance(conn: sqlite3.Connection, object_id: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute(APPLIANCE_SQL + " WHERE o.id = :i", {"i": object_id}).fetchone())


def records(conn: sqlite3.Connection, year: int, q: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM server_upgrades WHERE schedule_year = :y AND schedule_quarter = :q", {"y": year, "q": q})]


def record_for(conn: sqlite3.Connection, client_id: str, name: str, year: int, q: str) -> Optional[Dict[str, Any]]:
    return _d(conn.execute("SELECT * FROM server_upgrades WHERE client_id = :c AND server_name = :n"
                           " AND schedule_year = :y AND schedule_quarter = :q",
                           {"c": client_id, "n": name, "y": year, "q": q}).fetchone())


def insert_record(conn: sqlite3.Connection, v: Dict[str, Any]) -> None:
    conn.execute("INSERT INTO server_upgrades (id, client_id, server_name, environment, polarity, schedule_year,"
                 " schedule_quarter, target_version, scheduled_date, status, notes, created_at, updated_at)"
                 " VALUES (:id, :client_id, :server_name, :environment, :polarity, :year, :quarter, :target_version,"
                 " :scheduled_date, :status, :notes, :now, :now)", v)


def update_record(conn: sqlite3.Connection, rec_id: str, v: Dict[str, Any], now: str) -> None:
    conn.execute("UPDATE server_upgrades SET environment = :environment, polarity = :polarity, target_version = :target_version,"
                 " scheduled_date = :scheduled_date, status = :status, notes = :notes, updated_at = :now,"
                 " row_version = row_version + 1 WHERE id = :id", {**v, "id": rec_id, "now": now})


def delete_record(conn: sqlite3.Connection, rec_id: str) -> int:
    return conn.execute("DELETE FROM server_upgrades WHERE id = :i", {"i": rec_id}).rowcount


def records_named(conn: sqlite3.Connection, client_id: str, name: str) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute("SELECT * FROM server_upgrades WHERE client_id = :c AND server_name = :n",
                                          {"c": client_id, "n": name})]


def rename_record(conn: sqlite3.Connection, rec_id: str, new_name: str, now: str) -> None:
    conn.execute("UPDATE server_upgrades SET server_name = :n, updated_at = :now, row_version = row_version + 1 WHERE id = :i",
                 {"n": new_name, "i": rec_id, "now": now})

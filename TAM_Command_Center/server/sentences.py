"""Backend-generated one-line sentences for system events (docs/03 section 7, docs/04 section 7)."""
from __future__ import annotations

import json
from typing import Any, Optional


def _load(v: Any) -> dict:
    if isinstance(v, dict):
        return v
    if not v:
        return {}
    try:
        out = json.loads(v)
        return out if isinstance(out, dict) else {}
    except (TypeError, ValueError):
        return {}


def system_sentence(object_type: str, action: str, label: Optional[str], old: Any = None, new: Any = None,
                    severity: Optional[str] = None, source: Optional[str] = None) -> str:
    label = label or "(unnamed)"
    o, n = _load(old), _load(new)
    if object_type in ("bams_alert", "bams_alert_event"):
        sev = f" ({severity})" if severity else ""
        return f"BAMS alert {action}: {label}{sev}"
    if object_type == "task":
        return f"Task {action}: {label}"
    if object_type == "contact":
        if action == "primary_changed":
            was, now = o.get("primary_contact"), n.get("primary_contact")
            if now is None:
                return f"{label} is no longer primary"
            return f"{label} is now primary (was {was})" if was else f"{label} is now primary"
        verb = {"created": "added", "updated": "updated", "deleted": "removed"}.get(action, action)
        return f"Contact {verb}: {label}"
    if object_type == "note":
        if action == "deleted":
            return f"{o.get('note_type') or 'Note'} deleted: {label}"
        return f"Note {action}: {label}"
    if object_type == "client":
        if source == "Bulk Import" and action in ("created", "updated"):
            return f"Account {action} by bulk import"
        if action == "next_contact_changed":
            d = n.get("next_contact")
            return f"Next client touch set to {d}" if d else "Next client touch cleared"
        if action == "status_changed":
            return f"Account marked {n.get('status', '?')}"
        if action == "last_contact_changed":
            return f"Last contact set to {n.get('last_contact', '?')}"
        return f"Account {action}: {label}"
    if object_type == "server_upgrade":
        verb = {"created": "scheduled", "updated": "updated", "deleted": "deleted"}.get(action, action)
        return f"Server upgrade {verb}: {label}"
    return f"{object_type.replace('_', ' ').capitalize()} {action}: {label}"

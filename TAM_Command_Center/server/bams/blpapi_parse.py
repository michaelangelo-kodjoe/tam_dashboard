"""ALL Bloomberg response-shape knowledge lives here (docs/BLPAPI_NOTES.md section 3; every shape is [U] until the
workstation probe confirms it). Pure functions over blpapi-like Element/Message objects (hasElement, getElement,
getElementAsString, values, getValue), so a fake can stand in. If the real shapes differ, edit only this file.

Outcome per ticker: a float, or None (invalid ticker, bad field, no value, non numeric). Never raises."""
from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

# element / message names ([U])
EL_RESPONSE_ERROR = "responseError"
EL_SECURITY_DATA = "securityData"
EL_SECURITY = "security"
EL_SECURITY_ERROR = "securityError"
EL_FIELD_DATA = "fieldData"
EL_FIELD_EXCEPTIONS = "fieldExceptions"
EL_FIELD_ID = "fieldId"
EL_ERROR_INFO = "errorInfo"
EL_CATEGORY = "category"
EL_MESSAGE = "message"
MSG_SESSION_STARTUP_FAILURE = "SessionStartupFailure"
MSG_SESSION_TERMINATED = "SessionTerminated"
MSG_SESSION_CONN_DOWN = "SessionConnectionDown"
MSG_SERVICE_OPEN_FAILURE = "ServiceOpenFailure"
FATAL_SESSION_MESSAGES = (MSG_SESSION_STARTUP_FAILURE, MSG_SESSION_TERMINATED, MSG_SESSION_CONN_DOWN,
                          MSG_SERVICE_OPEN_FAILURE)


def _s(x: Any, n: int = 120) -> str:
    try:
        return str(x)[:n]
    except Exception:  # noqa: BLE001
        return "?"


def message_type(msg: Any) -> str:
    try:
        return str(msg.messageType())
    except Exception:  # noqa: BLE001
        return ""


def response_error(msg: Any) -> Optional[str]:
    """Whole-request failure text, or None."""
    try:
        if msg.hasElement(EL_RESPONSE_ERROR):
            e = msg.getElement(EL_RESPONSE_ERROR)
            cat = e.getElementAsString(EL_CATEGORY) if e.hasElement(EL_CATEGORY) else "?"
            return f"{cat}: {_s(e.getElementAsString(EL_MESSAGE)) if e.hasElement(EL_MESSAGE) else ''}"
    except Exception:  # noqa: BLE001
        return "unparseable responseError"
    return None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_refdata_message(msg: Any, field: str) -> Dict[str, Tuple[Optional[float], Optional[str]]]:
    """-> {security: (value|None, reason|None)} for every securityData entry in one ReferenceDataResponse message.
    A bad entry never affects the others."""
    out: Dict[str, Tuple[Optional[float], Optional[str]]] = {}
    try:
        if not msg.hasElement(EL_SECURITY_DATA):
            return out
        entries = list(msg.getElement(EL_SECURITY_DATA).values())
    except Exception:  # noqa: BLE001
        return out
    for sd in entries:
        try:
            sec = sd.getElementAsString(EL_SECURITY)
        except Exception:  # noqa: BLE001
            continue
        try:
            if sd.hasElement(EL_SECURITY_ERROR):
                e = sd.getElement(EL_SECURITY_ERROR)
                cat = e.getElementAsString(EL_CATEGORY) if e.hasElement(EL_CATEGORY) else "error"
                out[sec] = (None, "invalid security: " + _s(cat))
                continue
            reason: Optional[str] = None
            if sd.hasElement(EL_FIELD_EXCEPTIONS):
                for ex in sd.getElement(EL_FIELD_EXCEPTIONS).values():
                    if ex.getElementAsString(EL_FIELD_ID) == field:
                        info = ex.getElement(EL_ERROR_INFO) if ex.hasElement(EL_ERROR_INFO) else None
                        cat = info.getElementAsString(EL_CATEGORY) if info is not None and info.hasElement(EL_CATEGORY) else "error"
                        reason = "invalid field: " + _s(cat)
            if reason:
                out[sec] = (None, reason)
                continue
            fd = sd.getElement(EL_FIELD_DATA) if sd.hasElement(EL_FIELD_DATA) else None
            if fd is None or not fd.hasElement(field):
                out[sec] = (None, "no value")
                continue
            v = _num(fd.getElement(field).getValue())
            out[sec] = (v, None) if v is not None else (None, "non-numeric value")
        except Exception:  # noqa: BLE001
            out[sec] = (None, "unparseable entry")
    return out

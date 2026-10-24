"""Pydantic request models: strict (unknown fields rejected), trimmed strings, ISO dates (PM section 3.2).

Update bodies are patches: a field counts as "provided" only if it is in `model_fields_set`.
"""
from __future__ import annotations

import datetime as _dt
import re
from typing import Annotated, Any, Dict, Literal, Optional

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

Category = str  # validated against the enum tuples below to give uniform error messages

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_CTRL = ("\t", "\r", "\n")

TASK_CATEGORIES = ("Client Follow-Up", "Engineering Follow-Up", "Reporting", "Internal", "Escalation",
                   "Onboarding", "Entitlements", "Usage Review", "Meeting", "Other")
TASK_PRIORITIES = ("High", "Medium", "Low")
TASK_STATUSES = ("Not Started", "In Progress", "Waiting", "Complete")
NOTE_TYPES = ("Meeting Note", "Call Note", "General Note")
from .constants import CLIENT_STATUSES  # noqa: E402  (single constant, pinned to the schema CHECK by a test)


def _date(v: str) -> str:
    if not _DATE_RE.match(v):
        raise ValueError("must be a date in YYYY-MM-DD format")
    try:
        _dt.date.fromisoformat(v)
    except ValueError:
        raise ValueError("must be a valid calendar date (YYYY-MM-DD)") from None
    return v


def normalize_instant(v: str) -> str:
    s = v.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        t = _dt.datetime.fromisoformat(s)
    except ValueError:
        raise ValueError("must be an ISO-8601 date-time, e.g. 2026-10-12T14:05:00Z") from None
    if t.tzinfo is None:
        t = t.replace(tzinfo=_dt.timezone.utc)   # naive input is treated as UTC (docs/04 section 0)
    t = t.astimezone(_dt.timezone.utc)
    if not 2000 <= t.year <= 2100:
        raise ValueError("year out of range")
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _no_ctrl(v: str) -> str:
    if any(c in v for c in _CTRL):
        raise ValueError("must not contain tabs or line breaks")
    return v


DateStr = Annotated[str, AfterValidator(_date)]
InstantStr = Annotated[str, AfterValidator(normalize_instant)]
Text = Annotated[str, AfterValidator(_no_ctrl)]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("*", mode="after")
    @classmethod
    def _empty_to_none(cls, v: Any) -> Any:
        return None if isinstance(v, str) and v == "" else v

    def provided(self, *exclude: str) -> Dict[str, Any]:
        return {k: getattr(self, k) for k in self.model_fields_set if k not in exclude}


class ClientSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    expected_row_version: Optional[int] = Field(default=None, ge=1)
    name: Optional[Annotated[Text, Field(min_length=1, max_length=200)]] = None
    bpid: Optional[Annotated[Text, Field(max_length=32)]] = None
    products: Optional[Annotated[str, Field(max_length=500)]] = None
    status: Optional[str] = None
    next_contact: Optional[DateStr] = None
    notes: Optional[Annotated[str, Field(max_length=20000)]] = None
    duplicates_confirmed: bool = False          # PM-AC-4 / D-45: create only; ignored on update

    @field_validator("status")
    @classmethod
    def _status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in CLIENT_STATUSES:
            raise ValueError("must be one of: " + ", ".join(CLIENT_STATUSES))
        return v


class ClientDelete(Body):
    id: str = Field(min_length=1, max_length=64)
    confirm: bool = False
    confirm_name: Optional[str] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class ContactSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    expected_row_version: Optional[int] = Field(default=None, ge=1)
    client_id: Optional[str] = Field(default=None, max_length=64)
    name: Optional[Annotated[Text, Field(min_length=1, max_length=200)]] = None
    role: Optional[Annotated[str, Field(max_length=200)]] = None
    email: Optional[Annotated[str, Field(max_length=254)]] = None
    team: Optional[Annotated[str, Field(max_length=200)]] = None
    is_primary: Optional[bool] = None

    @field_validator("email")
    @classmethod
    def _email(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and (not _EMAIL_RE.match(v) or ".." in v):
            raise ValueError("must look like name@example.com")
        return v


class DeleteBody(Body):
    id: str = Field(min_length=1, max_length=64)
    confirm: bool = False
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class TaskSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    expected_row_version: Optional[int] = Field(default=None, ge=1)
    task: Optional[Annotated[Text, Field(min_length=1, max_length=500)]] = None
    client_id: Optional[str] = Field(default=None, max_length=64)
    category: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    due: Optional[DateStr] = None
    next_update: Optional[DateStr] = None
    waiting: Optional[Annotated[str, Field(max_length=500)]] = None
    notes: Optional[Annotated[str, Field(max_length=20000)]] = None
    update_next_contact: bool = False

    @field_validator("category")
    @classmethod
    def _cat(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in TASK_CATEGORIES:
            raise ValueError("must be one of: " + ", ".join(TASK_CATEGORIES))
        return v

    @field_validator("priority")
    @classmethod
    def _prio(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in TASK_PRIORITIES:
            raise ValueError("must be one of: " + ", ".join(TASK_PRIORITIES))
        return v

    @field_validator("status")
    @classmethod
    def _stat(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in TASK_STATUSES:
            raise ValueError("must be one of: " + ", ".join(TASK_STATUSES))
        return v


class TaskArchive(Body):
    id: str = Field(min_length=1, max_length=64)
    archived: bool
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class NoteSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    expected_row_version: Optional[int] = Field(default=None, ge=1)
    client_id: Optional[str] = Field(default=None, max_length=64)
    note_type: Optional[str] = None
    timestamp: Optional[InstantStr] = None
    subject: Optional[Annotated[str, Field(max_length=200)]] = None
    body: Optional[Annotated[str, Field(max_length=50000)]] = None
    body_format: Optional[Literal["plain", "html"]] = None      # "html": body is sanitised server-side (server/richtext.py)
    action_items: Optional[Annotated[str, Field(max_length=10000)]] = None

    @field_validator("note_type")
    @classmethod
    def _nt(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in NOTE_TYPES:
            raise ValueError("must be one of: " + ", ".join(NOTE_TYPES))
        return v


class SettingsSave(Body):
    settings: Dict[str, Any]


class DevReseed(Body):
    confirm: bool = False


class EmptyBody(Body):
    pass


class CheckSimilar(Body):
    name: Annotated[Text, Field(min_length=1, max_length=200)]
    bpid: Optional[Annotated[Text, Field(max_length=32)]] = None


class ImportTarget(Body):
    type: str = Field(pattern="^(account|row)$")
    id: Optional[str] = Field(default=None, max_length=64)
    row: Optional[int] = Field(default=None, ge=2, le=100000)


class ImportDecision(Body):
    row: int = Field(ge=2, le=100000)
    choice: str = Field(pattern="^(same|different|skip)$")
    target: Optional[ImportTarget] = None


class ImportApply(Body):
    import_id: str = Field(min_length=1, max_length=64)
    plan_hash: str = Field(min_length=1, max_length=100)
    confirm: bool = False
    decisions: list[ImportDecision] = Field(default_factory=list, max_length=500)


class BamsImportTarget(Body):
    type: str = Field(pattern="^(appliance|group)$")
    id: Optional[str] = Field(default=None, max_length=64)
    key: Optional[str] = Field(default=None, pattern=r"^g\d{1,6}$")


class BamsImportDecision(Body):
    key: str = Field(pattern=r"^g\d{1,6}$")
    choice: str = Field(pattern="^(same|different|skip)$")
    target: Optional[BamsImportTarget] = None


class BamsImportApply(Body):
    import_id: str = Field(min_length=1, max_length=64)
    plan_hash: str = Field(min_length=1, max_length=100)
    confirm: bool = False
    decisions: list[BamsImportDecision] = Field(default_factory=list, max_length=500)

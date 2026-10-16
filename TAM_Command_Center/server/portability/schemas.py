"""Strict bodies for /api/restore/* (docs/04_API_CONTRACT.md section 14)."""
from __future__ import annotations

from typing import Literal

from pydantic import ConfigDict, Field

from ..schemas import Body

TableKey = Literal["accounts", "contacts", "tasks", "notes", "appliances", "metrics", "quarters", "records"]


class RestoreApply(Body):
    restore_id: str = Field(min_length=1, max_length=64)
    plan_hash: str = Field(min_length=1, max_length=100)
    confirm: bool = False


class RestoreRemove(Body):
    file_id: str = Field(min_length=1, max_length=64)


class RestoreTable(Body):
    file_id: str = Field(min_length=1, max_length=64)
    table: TableKey


class DbFromBackup(Body):
    name: str = Field(min_length=1, max_length=200)


class DbRestoreApply(Body):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)     # the typed word must match exactly

    restore_id: str = Field(min_length=1, max_length=64)
    confirm: str = Field(default="", max_length=20)

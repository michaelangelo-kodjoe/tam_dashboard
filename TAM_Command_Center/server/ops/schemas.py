"""Strict request bodies for /api/operations/* (docs/04_API_CONTRACT.md section 13)."""
from __future__ import annotations

from typing import Annotated, List, Literal, Optional

from pydantic import AfterValidator, Field, StrictInt, field_validator

from ..schemas import Body, DateStr

Quarter = Literal["Q1", "Q2", "Q3", "Q4"]
Status = Literal["Planned", "Awaiting Client", "Scheduled", "In Progress", "Completed", "Deferred",
                 "Validation Required", "Exception"]
Year = Annotated[StrictInt, Field(ge=2000, le=2100)]


def _version(v: str) -> str:
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise ValueError("must not contain control characters")
    return v


Version = Annotated[str, AfterValidator(_version), Field(max_length=50)]


class QuarterSave(Body):
    """No expected_row_version = create (duplicate year+quarter -> 409); with it = update (identity cannot change)."""
    year: Year
    quarter: Quarter
    apics_version: Optional[Version] = None
    dev_upgrade_date: Optional[DateStr] = None
    east_prod_date: Optional[DateStr] = None
    west_prod_date: Optional[DateStr] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class QuarterDelete(Body):
    year: Year
    quarter: Quarter
    confirm: bool = False
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class ApplianceSave(Body):
    object_id: str = Field(min_length=1, max_length=64)
    year: Year
    quarter: Quarter
    status: Optional[Status] = None
    date_override: Optional[DateStr] = None
    target_version: Optional[Version] = None
    notes: Optional[Annotated[str, Field(max_length=20000)]] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)

    @field_validator("status")
    @classmethod
    def _status_not_null(cls, v: Optional[str]) -> Optional[str]:
        return v


class ApplianceReset(Body):
    object_id: str = Field(min_length=1, max_length=64)
    year: Year
    quarter: Quarter
    confirm: bool = False
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class SetVersion(Body):
    year: Year
    quarter: Quarter
    object_ids: List[Annotated[str, Field(min_length=1, max_length=64)]] = Field(min_length=1, max_length=500)
    target_version: Optional[Version] = None

"""Strict request bodies for /api/bams/* and /api/dev/bams/* (docs/04_API_CONTRACT.md section 11)."""
from __future__ import annotations

import re
from typing import Annotated, List, Literal, Optional

from pydantic import AfterValidator, Field, StrictBool, StrictInt, model_validator

from ..schemas import Body, InstantStr

_WS = re.compile(r" {2,}")


def _clean(v: str) -> str:
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise ValueError("must not contain control characters")
    return _WS.sub(" ", v)


def _ticker(v: str) -> str:
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise ValueError("must not contain control characters")
    return v


Name = Annotated[str, AfterValidator(_clean), Field(min_length=1, max_length=200)]
Ticker = Annotated[str, AfterValidator(_ticker), Field(min_length=1, max_length=200)]
Num = Annotated[float, Field(allow_inf_nan=False, ge=-1e12, le=1e12)]
Severity = Literal["Info", "Warning", "Critical"]
RuleType = Literal["fixed_threshold", "pct_of_high", "exceeds_high"]
Operator = Literal[">", ">=", "<", "<="]
Period = Literal["30d", "60d", "90d"]


class BamsSettingsSave(Body):
    poll_interval_seconds: Optional[Annotated[StrictInt, Field(ge=30, le=86400)]] = None
    in_app_notifications: Optional[StrictBool] = None
    desktop_notifications: Optional[StrictBool] = None
    notify_recovered: Optional[StrictBool] = None
    privacy_mode: Optional[StrictBool] = None


class CloseAlert(Body):
    note: Optional[Annotated[str, Field(max_length=2000)]] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class MetricIn(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    metric_name: Optional[Name] = None
    ticker: Optional[Ticker] = None
    enabled: Optional[StrictBool] = None
    stale_after_seconds: Optional[Annotated[StrictInt, Field(ge=1, le=31536000)]] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class MetricSave(MetricIn):
    object_id: Optional[str] = Field(default=None, max_length=64)


class ObjectSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    client_id: Optional[str] = Field(default=None, max_length=64)
    name: Optional[Name] = None
    region: Optional[Annotated[str, Field(max_length=100)]] = None
    location: Optional[Annotated[str, Field(max_length=200)]] = None
    environment: Optional[Literal["PROD", "DEV"]] = None
    enabled: Optional[StrictBool] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)
    metrics: Optional[List[MetricIn]] = Field(default=None, max_length=200)


class DeleteById(Body):
    id: str = Field(min_length=1, max_length=64)
    confirm: bool = False
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class RuleSave(Body):
    id: Optional[str] = Field(default=None, max_length=64)
    metric_id: Optional[str] = Field(default=None, max_length=64)
    rule_type: Optional[RuleType] = None
    operator: Optional[Operator] = None
    threshold: Optional[Num] = None
    reference_period: Optional[Period] = None
    consecutive_updates: Optional[StrictInt] = None
    severity: Optional[Severity] = None
    cooldown_minutes: Optional[StrictInt] = None
    enabled: Optional[StrictBool] = None
    suppress_until_clear: Optional[StrictBool] = None
    expected_row_version: Optional[int] = Field(default=None, ge=1)


class ConfigSave(RuleSave):
    name: Optional[Name] = None
    metric_match: Optional[Annotated[str, AfterValidator(_ticker), Field(min_length=1, max_length=200)]] = None
    # When true this configuration is a persistent metric policy: every enabled metric
    # matching metric_match inherits/updates a managed rule automatically.
    auto_apply: Optional[StrictBool] = None
    metric_id: None = None
    suppress_until_clear: None = None


class ConfigDelete(Body):
    id: str = Field(min_length=1, max_length=64)
    confirm: bool = False


class ConfigApply(Body):
    config_id: str = Field(min_length=1, max_length=64)
    metric_ids: Optional[List[Annotated[str, Field(max_length=64)]]] = Field(default=None, max_length=2000)
    preview: bool = True
    confirm: bool = False
    plan_hash: Optional[str] = Field(default=None, max_length=100)


class NotificationsRead(Body):
    through_id: Optional[StrictInt] = Field(default=None, ge=1)
    all: Optional[StrictBool] = None

    @model_validator(mode="after")
    def _one(self) -> "NotificationsRead":
        if (self.through_id is None) == (self.all is not True):
            raise ValueError("send exactly one of through_id or all=true")
        return self


class DevForce(Body):
    metric_id: str = Field(min_length=1, max_length=64)
    value: Num
    poll: bool = True


class DevStale(Body):
    metric_id: Optional[str] = Field(default=None, max_length=64)
    on: bool = True


class DevOutage(Body):
    on: bool = True


class DevClock(Body):
    advance_seconds: Optional[Annotated[float, Field(ge=0, le=86400 * 400, allow_inf_nan=False)]] = None
    set: Optional[InstantStr] = None
    reset: Optional[StrictBool] = None

    @model_validator(mode="after")
    def _one(self) -> "DevClock":
        n = sum(x is not None for x in (self.advance_seconds, self.set, self.reset))
        if n != 1:
            raise ValueError("send exactly one of advance_seconds, set, reset")
        return self


class DevReset(Body):
    confirm: bool = False

"""HTTP routes for Operations. Thin: validate -> service -> JSON. No SQL here."""
from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Query

from . import service
from .schemas import ApplianceReset, ApplianceSave, Quarter, QuarterDelete, QuarterSave, SetVersion, Status


def register(api: APIRouter, rt: Any) -> None:
    S = service

    @api.get("/operations")
    def operations(year: Optional[int] = Query(None, ge=2000, le=2100), quarter: Optional[Quarter] = None,
                   q: Optional[str] = Query(None, max_length=200), status: Optional[Status] = None,
                   environment: Optional[Literal["PROD", "DEV", "unset"]] = None,
                   polarity: Optional[Literal["East", "West", "unset"]] = None,
                   client_id: Optional[str] = Query(None, max_length=64)) -> Dict[str, Any]:
        return S.get(rt, year, quarter, {"q": q, "status": status, "environment": environment,
                                         "polarity": polarity, "client_id": client_id})

    @api.post("/operations/quarter/save")
    def quarter_save(body: QuarterSave) -> Dict[str, Any]:
        return S.quarter_save(rt, body)

    @api.post("/operations/quarter/delete")
    def quarter_delete(body: QuarterDelete) -> Dict[str, Any]:
        return S.quarter_delete(rt, body)

    @api.post("/operations/appliance/save")
    def appliance_save(body: ApplianceSave) -> Dict[str, Any]:
        return S.appliance_save(rt, body)

    @api.post("/operations/appliance/reset")
    def appliance_reset(body: ApplianceReset) -> Dict[str, Any]:
        return S.appliance_reset(rt, body)

    @api.post("/operations/appliance/set-version")
    def set_version(body: SetVersion) -> Dict[str, Any]:
        return S.set_version(rt, body)

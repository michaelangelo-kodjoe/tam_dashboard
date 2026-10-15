"""HTTP routes for BAMS monitoring. Thin: validate -> service -> JSON. No SQL here."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from . import reads, repo, service
from .monitor import make_ctx
from .schemas import (BamsSettingsSave, CloseAlert, ConfigApply, ConfigDelete, ConfigSave, DeleteById, DevClock,
                      DevForce, DevOutage, DevReset, DevStale, MetricSave, NotificationsRead, ObjectSave, RuleSave)
from ..errors import MethodNotAllowed, NotFound
from ..importer import bams_service as imp
from ..schemas import BamsImportApply, EmptyBody


def register(api: APIRouter, rt: Any) -> None:
    S = service

    @api.get("/bams/state")
    def state(view: Optional[str] = None, account: Optional[str] = Query(None, max_length=4000),
              object_id: Optional[str] = Query(None, max_length=64), location: Optional[str] = Query(None, max_length=200),
              metric: Optional[str] = Query(None, max_length=200), status: Optional[str] = None,
              q: Optional[str] = Query(None, max_length=300), sort: Optional[str] = None, dir: Optional[str] = None,
              include_disabled: bool = False, spark: int = Query(1, ge=0, le=1)) -> Dict[str, Any]:
        params = dict(view=view, account=account, object_id=object_id, location=location, metric=metric, status=status,
                      q=q, sort=sort, dir=dir, include_disabled=include_disabled, spark=spark)
        with rt.db() as conn:
            ctx = make_ctx(rt.bams, conn)
            return reads.build_state(conn, ctx, S.monitor_block(rt, conn), rt.bams.provider_info(), S.banner(rt), params)

    @api.get("/bams/monitor")
    def monitor() -> Dict[str, Any]:
        return S.monitor_get(rt)

    @api.post("/bams/monitor/start")
    def monitor_start(body: EmptyBody) -> Dict[str, Any]:
        return S.monitor_start(rt)

    @api.post("/bams/monitor/stop")
    def monitor_stop(body: EmptyBody) -> Dict[str, Any]:
        return S.monitor_stop(rt)

    @api.get("/bams/settings")
    def settings_get() -> Dict[str, Any]:
        return S.settings_get(rt)

    @api.post("/bams/settings")
    def settings_save(body: BamsSettingsSave) -> Dict[str, Any]:
        return S.settings_save(rt, body)

    @api.get("/bams/metric/{metric_id}")
    def metric_detail(metric_id: str, alerts_limit: int = Query(50, ge=1, le=200)) -> Dict[str, Any]:
        with rt.db() as conn:
            return reads.metric_detail(conn, make_ctx(rt.bams, conn), metric_id, alerts_limit)

    @api.get("/bams/metric/{metric_id}/trend")
    def metric_trend(metric_id: str, range: str = "7d") -> Dict[str, Any]:
        with rt.db() as conn:
            return reads.trend(conn, make_ctx(rt.bams, conn), metric_id, range)

    @api.get("/bams/alerts")
    def alerts(status: str = "active", account: Optional[str] = Query(None, max_length=4000),
               metric_id: Optional[str] = Query(None, max_length=64), limit: int = Query(100, ge=1, le=500),
               before: Optional[str] = Query(None, max_length=40)) -> Dict[str, Any]:
        with rt.db() as conn:
            return reads.alerts_list(conn, make_ctx(rt.bams, conn), status, account, metric_id, limit, before)

    @api.post("/bams/alert/{event_id}/close")
    def alert_close(event_id: str, body: CloseAlert) -> Dict[str, Any]:
        return S.close_alert(rt, event_id, body)

    @api.post("/bams/object/save")
    def object_save(body: ObjectSave) -> Dict[str, Any]:
        return S.object_save(rt, body)

    @api.post("/bams/metric/save")
    def metric_save(body: MetricSave) -> Dict[str, Any]:
        return S.metric_save(rt, body)

    @api.get("/bams/object/{item_id}/delete-preview")
    def object_preview(item_id: str) -> Dict[str, Any]:
        return S.delete_preview_route(rt, "object", item_id)

    @api.get("/bams/metric/{item_id}/delete-preview")
    def metric_preview(item_id: str) -> Dict[str, Any]:
        return S.delete_preview_route(rt, "metric", item_id)

    @api.post("/bams/object/delete")
    def object_delete(body: DeleteById) -> Dict[str, Any]:
        return S.delete_item(rt, "object", body)

    @api.post("/bams/metric/delete")
    def metric_delete(body: DeleteById) -> Dict[str, Any]:
        return S.delete_item(rt, "metric", body)

    @api.post("/bams/rule/save")
    def rule_save(body: RuleSave) -> Dict[str, Any]:
        return S.rule_save(rt, body)

    @api.post("/bams/rule/delete")
    def rule_delete(body: DeleteById) -> Dict[str, Any]:
        return S.rule_delete(rt, body)

    @api.get("/bams/configs")
    def configs() -> Dict[str, Any]:
        with rt.db() as conn:
            return reads.configs_list(conn)

    @api.post("/bams/configs/save")
    def configs_save(body: ConfigSave) -> Dict[str, Any]:
        return S.configs_save(rt, body)

    @api.post("/bams/configs/delete")
    def configs_delete(body: ConfigDelete) -> Dict[str, Any]:
        return S.configs_delete(rt, body)

    @api.post("/bams/configs/apply")
    def configs_apply(body: ConfigApply) -> Dict[str, Any]:
        return S.configs_apply(rt, body)

    @api.get("/bams/notifications")
    def notifications(limit: int = Query(50, ge=1, le=200), unread_only: bool = False) -> Dict[str, Any]:
        with rt.db() as conn:
            return reads.notifications(conn, limit, unread_only)

    @api.post("/bams/notifications/read")
    def notifications_read(body: NotificationsRead) -> Dict[str, Any]:
        return S.notifications_read(rt, body)


def register_import(api: APIRouter, rt: Any) -> None:
    """BAMS appliance + metrics import (docs/04_API_CONTRACT.md section 12)."""

    def file_response(f: Dict[str, Any]) -> Response:
        return Response(content=f["data"], media_type=f["media"], headers={
            "Content-Disposition": f'attachment; filename="{f["filename"]}"', "Cache-Control": "no-store"})

    @api.get("/import/bams/template")
    def template(format: str = Query("xlsx")) -> Response:
        return file_response(imp.template_file(format))

    @api.post("/import/bams/inspect")
    async def inspect(request: Request) -> Dict[str, Any]:
        data = await request.body()                       # the 5 MiB cap is enforced by BodyLimit
        item = await run_in_threadpool(imp.inspect, rt, data, request.headers.get("x-file-name"))
        return {"ok": True, "item": item, "side_effects": []}

    @api.post("/import/bams/apply")
    def apply(body: BamsImportApply) -> Dict[str, Any]:
        return {"ok": True, **imp.apply(rt, body)}

    @api.get("/import/bams/{import_id}/skipped.{fmt}")
    def skipped(import_id: str, fmt: str) -> Response:
        if fmt not in ("xlsx", "csv"):
            raise NotFound("Unknown API route.")
        return file_response(imp.skipped_file(rt, import_id, fmt))

    @api.get("/import/bams/{import_id}")
    def plan(import_id: str) -> Any:
        if import_id in ("inspect", "apply"):
            resp = JSONResponse(MethodNotAllowed("Method not allowed on this path.", details={"allowed": ["POST"]}).body(),
                                status_code=405, headers={"Allow": "POST", "Cache-Control": "no-store"})
            return resp
        return {"ok": True, "item": imp.get_plan(rt, import_id), "side_effects": []}


def register_dev(api: APIRouter, rt: Any) -> None:
    """Only called when the runtime is DEV; in PROD these paths do not exist (404)."""
    S = service

    @api.post("/dev/bams/force-value")
    def force(body: DevForce) -> Dict[str, Any]:
        return S.dev_force(rt, body)

    @api.post("/dev/bams/simulate-stale")
    def stale(body: DevStale) -> Dict[str, Any]:
        return S.dev_stale(rt, body)

    @api.post("/dev/bams/simulate-outage")
    def outage(body: DevOutage) -> Dict[str, Any]:
        return S.dev_outage(rt, body)

    @api.post("/dev/bams/poll")
    def poll(body: EmptyBody) -> Dict[str, Any]:
        return S.dev_poll(rt)

    @api.post("/dev/bams/clock")
    def clock(body: DevClock) -> Dict[str, Any]:
        return S.dev_clock(rt, body)

    @api.post("/dev/bams/reset")
    def reset(body: DevReset) -> Dict[str, Any]:
        return S.dev_reset(rt, body)

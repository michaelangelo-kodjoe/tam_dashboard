"""FastAPI application factory. Routes are thin: validation -> service -> JSON. No SQL here."""
from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import constants as C
from . import infra, reads, services
from .importer import service as import_service
from .config import Config
from .errors import (AppError, ForbiddenOrigin, MethodNotAllowed, NotFound, NotImplementedYet, PayloadTooLarge,
                     ValidationFailed)
from .logsetup import is_disconnect, log_connection_event, tail
from .runtime import Runtime
from .schemas import (CheckSimilar, ImportApply, ClientDelete, ClientSave, ContactSave, DeleteBody, DevReseed, EmptyBody, NoteSave,
                      SettingsSave, TaskArchive, TaskSave)
from .bams import routes as bams_routes
from .ops import routes as ops_routes
from .bams.clock import Clock as BamsClock
from .bams.monitor import Monitor
from .bams.notify import select_notifier
from .bams.provider import select_provider
from .today import build_today
from .trends import TREND_DAYS, activity_trend

log = logging.getLogger("tam.api")

_STUB_PHASES = {
    "operations": "Phase 3: Operations (schedule sync and server-upgrade importers are out of scope, D-118)",
    "export": "Phase 5: data portability",
    "import": "Phase 5: data portability",
    "data/reset": "Phase 5: data portability",
    "restore": "Phase 5: data portability",
    "context": "Phase 5: ChatGPT Bridge",
    "chat": "Phase 5: ChatGPT Bridge",
}
_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]

# QA-E1-2: the compiled bundle loads only same-origin scripts/styles and one data: favicon. Styles keep
# 'unsafe-inline' because Recharts/React emit inline style attributes; scripts do not.
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
                                "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"),
}


class PreflightGuard:
    """Pure ASGI middleware wrapped around CORSMiddleware (QA-E2-1): a CORS-rejected preflight becomes a structured
    400 `cors_rejected`, and every response CORSMiddleware answers itself still carries the security headers."""

    def __init__(self, app: Any, origins: List[str]) -> None:
        self.app, self.origins = app, set(origins)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        h = {k.lower(): v for k, v in scope.get("headers", [])}
        origin = h.get(b"origin", b"").decode("latin-1")
        if (scope["method"] == "OPTIONS" and origin and b"access-control-request-method" in h
                and origin not in self.origins and "*" not in self.origins):
            err = AppError("Cross-origin request not allowed.")
            err.code, err.status = "cors_rejected", 400  # type: ignore[assignment]
            resp = _json(err.status, err.body())
            for k, v in SECURITY_HEADERS.items():
                resp.headers[k] = v
            resp.headers["Cache-Control"] = "no-store"
            await resp(scope, receive, send)
            return

        async def wrapped(msg: Any) -> None:
            if msg["type"] == "http.response.start":
                present = {k.lower() for k, _ in msg.get("headers", [])}
                extra = [(k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS.items()
                         if k.lower().encode() not in present]
                msg = {**msg, "headers": list(msg.get("headers", [])) + extra}
            await send(msg)
        await self.app(scope, receive, wrapped)


class BodyLimit:
    """Pure ASGI middleware (QA-E1-4): reject request bodies over `limit` bytes with a structured 413.
    A declared Content-Length is checked up front; chunked bodies are buffered up to the cap and replayed."""

    def __init__(self, app: Any, limit: int, route_limits: Optional[Dict[str, int]] = None) -> None:
        self.app, self.default_limit, self.route_limits = app, limit, dict(route_limits or {})
        self.limit = limit

    async def _reject(self, send: Any, limit: int) -> None:
        body = json.dumps(PayloadTooLarge(
            f"Request body exceeds the {limit // (1024 * 1024)} MB limit.",
            details={"max_bytes": limit, "reason": "too_large"}).body()).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                   (b"cache-control", b"no-store"), (b"connection", b"close")]
        headers += [(k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS.items()]
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.route_limits.get(scope.get("path", ""), self.default_limit)   # documented per-route override
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > limit
            except ValueError:
                too_big = False
            if too_big:
                await self._reject(send, limit)
                return
            await self.app(scope, receive, send)
            return
        # No Content-Length: only a chunked body can be large. Buffer up to the cap, then replay.
        messages, total = [], 0
        while True:
            msg = await receive()
            messages.append(msg)
            if msg["type"] != "http.request":
                break
            total += len(msg.get("body", b""))
            if total > limit:
                await self._reject(send, limit)
                return
            if not msg.get("more_body", False):
                break
        replay = iter(messages)

        async def replay_receive() -> Any:
            try:
                return next(replay)
            except StopIteration:
                return await receive()

        await self.app(scope, replay_receive, send)


def _json(status: int, body: Dict[str, Any]) -> JSONResponse:
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def _validation_fields(exc: RequestValidationError) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    for e in exc.errors():
        loc = [str(p) for p in e.get("loc", ()) if p not in ("body", "query", "path")]
        key = ".".join(loc) or "body"
        msg = str(e.get("msg", "invalid"))
        if msg.startswith("Value error, "):
            msg = msg[len("Value error, "):]
        if e.get("type") == "extra_forbidden":
            msg = "unknown field"
        fields.setdefault(key, msg)
    return fields


def create_app(config: Config, *, acquire_lock: bool = True, clock: Any = None, utc_base: Any = None,
               monitor_thread: bool = False, provider: Any = None, notifier: Any = None) -> FastAPI:
    rt = Runtime(config, acquire_lock=acquire_lock, clock=clock)
    # BAMS monitor (D-49..D-51): provider and notifier come from the MODE only; tests may inject fakes.
    rt.bams = Monitor(rt, provider or select_provider(config.mode), notifier or select_notifier(config.mode),
                      BamsClock(utc_base), threaded=monitor_thread)
    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        if monitor_thread:
            rt.bams.resume()
        yield
        rt.close()

    app = FastAPI(title="TAM Command Center API", version=config.version, docs_url=None, redoc_url=None,
                  openapi_url="/openapi.json" if config.mode == "DEV" else None, lifespan=lifespan)
    app.state.runtime = rt

    # ------------------------------------------------------------ middleware (outermost last)
    @app.middleware("http")
    async def guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        t0 = time.perf_counter()
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
        try:
            if host not in ("127.0.0.1", "localhost", "::1"):
                raise ForbiddenOrigin("Requests must use 127.0.0.1 or localhost.")
            origin = request.headers.get("origin")
            if origin and request.method not in ("GET", "HEAD", "OPTIONS") and origin not in config.allowed_origins:
                raise ForbiddenOrigin("Cross-origin writes are not allowed.")
            response = await call_next(request)
        except AppError as exc:
            response = _json(exc.status, exc.body())
        except Exception as exc:  # noqa: BLE001
            if is_disconnect(exc):
                log_connection_event(exc)
                response = _json(499, {"ok": False, "error": {"code": "client_closed", "message": "connection closed"}})
            else:
                log.exception("unhandled error on %s %s", request.method, request.url.path)
                response = _json(500, {"ok": False, "error": {"code": "internal",
                                                              "message": "Unexpected server error. See the log."}})
        for k, v in SECURITY_HEADERS.items():
            response.headers[k] = v
        if request.url.path.startswith("/api") or response.headers.get("content-type", "").startswith("application/json"):
            response.headers["Cache-Control"] = "no-store"
        log.debug("%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code,
                  (time.perf_counter() - t0) * 1000)
        return response

    if config.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_methods=["GET", "POST"],
                           allow_headers=["Content-Type", "X-File-Name"], allow_credentials=False)
        app.add_middleware(PreflightGuard, origins=config.cors_origins)   # outside CORS: QA-E2-1
    app.add_middleware(BodyLimit, limit=C.MAX_BODY_BYTES, route_limits=C.IMPORT_ROUTE_LIMITS)      # outermost: rejects before anything reads the body

    # ------------------------------------------------------------ error handlers
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):  # type: ignore[no-untyped-def]
        if exc.status >= 500:
            log.error("%s %s -> %s: %s", request.method, request.url.path, exc.code, exc.message)
        else:
            log.info("%s %s -> %s: %s", request.method, request.url.path, exc.code, exc.message)
        return _json(exc.status, exc.body())

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):  # type: ignore[no-untyped-def]
        err = ValidationFailed("Request validation failed.", fields=_validation_fields(exc))
        log.info("%s %s -> validation_error %s", request.method, request.url.path, err.fields)
        return _json(422, err.body())

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):  # type: ignore[no-untyped-def]
        if exc.status_code == 404:
            err: AppError = NotFound("Not found.")
        elif exc.status_code == 405:
            err = MethodNotAllowed("Method not allowed on this path.")
        else:
            err = AppError(str(exc.detail))
            err.code, err.status = "http_error", exc.status_code  # type: ignore[assignment]
        return _json(err.status, err.body())

    api = APIRouter(prefix="/api")

    # ------------------------------------------------------------ runtime / state
    def runtime_info(conn) -> Dict[str, Any]:  # type: ignore[no-untyped-def]
        return {"mode": config.mode, "channel": config.channel, "version": config.version,
                "schema_version": reads.schema_version(conn), "db_path": str(config.db_path),
                "backup_dir": str(config.backup_dir), "log_dir": str(config.log_dir), "port": config.port}

    @api.get("/health")
    def health() -> Dict[str, Any]:
        with rt.db() as conn:
            r = runtime_info(conn)
        return {"ok": True, "mode": r["mode"], "channel": r["channel"], "version": r["version"],
                "schema_version": r["schema_version"], "db_path": r["db_path"]}

    @api.get("/state")
    def state() -> Dict[str, Any]:
        today = rt.today()
        with rt.db() as conn:
            return {"ok": True, "today": today, "runtime": runtime_info(conn),
                    "settings": reads.public_settings(reads.read_settings(conn)),
                    "accounts": reads.list_accounts(conn, today),
                    "tasks": reads.query_tasks(conn, archived="false", limit=C.TASKS_MAX_LIMIT),
                    "contacts": reads.list_contacts(conn),
                    "infrastructure": infra.build_infrastructure(conn, config.channel, include_metrics=False,
                                                                today=today, provider_available=rt.bams.provider.availability()[0])}

    @api.get("/today")
    def today() -> Dict[str, Any]:
        with rt.db() as conn:
            return {"ok": True, **build_today(conn, rt.today(), rt.tz)}

    @api.get("/accounts/activity-trend")
    def accounts_activity_trend(days: int = Query(TREND_DAYS), include_inactive: bool = Query(False)) -> Dict[str, Any]:
        if days != TREND_DAYS:
            raise ValidationFailed("Request validation failed.", fields={"days": f"must be {TREND_DAYS}"})
        today = rt.today()
        with rt.db() as conn:
            return {"ok": True, "today": today, "days": TREND_DAYS,
                    "series": activity_trend(conn, today, rt.tz, include_inactive=include_inactive)}

    @api.get("/settings")
    def get_settings() -> Dict[str, Any]:
        with rt.db() as conn:
            return {"ok": True, "settings": reads.public_settings(reads.read_settings(conn))}

    @api.post("/settings/save")
    def save_settings(body: SettingsSave) -> Dict[str, Any]:
        return services.save_settings(rt, body)

    @api.get("/logs/recent")
    def logs_recent(limit: int = Query(C.LOGS_DEFAULT_LIMIT, ge=1, le=C.LOGS_MAX_LIMIT)) -> Dict[str, Any]:
        path = rt.log_file
        return {"ok": True, "lines": tail(path, limit) if path else [], "log_file": str(path) if path else None}

    # ------------------------------------------------------------ reads
    @api.get("/tasks")
    def tasks(client_id: Optional[str] = None,
              archived: str = Query("false", pattern="^(true|false|all)$"),
              status: Optional[str] = Query(None, pattern="^(open|Not Started|In Progress|Waiting|Complete)$"),
              priority: Optional[str] = Query(None, pattern="^(High|Medium|Low)$"),
              category: Optional[str] = None, q: Optional[str] = Query(None, max_length=200),
              limit: int = Query(C.TASKS_DEFAULT_LIMIT, ge=1, le=C.TASKS_MAX_LIMIT)) -> Dict[str, Any]:
        with rt.db() as conn:
            items = reads.query_tasks(conn, client_id=client_id, archived=archived, status=status,
                                      priority=priority, category=category, q=q, limit=limit)
        return {"ok": True, "items": items, "count": len(items)}

    @api.get("/client/{client_id}/activity")
    def activity(client_id: str, filter: str = Query("all", pattern="^(all|meeting|call|general|system)$"),
                 q: Optional[str] = Query(None, max_length=200), before: Optional[str] = Query(None, max_length=500),
                 limit: int = Query(C.ACTIVITY_DEFAULT_LIMIT, ge=1, le=C.ACTIVITY_MAX_LIMIT)) -> Dict[str, Any]:
        with rt.db() as conn:
            page = reads.activity_page(conn, client_id, filter_=filter, q=q, before=before, limit=limit)
        return {"ok": True, **page}

    @api.get("/note/{note_id}")
    def note_get(note_id: str) -> Any:
        if note_id in ("save", "delete"):          # write routes: GET is the wrong method, not a missing note
            resp = _json(405, MethodNotAllowed("Method not allowed on this path.", details={"allowed": ["POST"]}).body())
            resp.headers["Allow"] = "POST"                # QA-E2-2
            return resp
        with rt.db() as conn:
            raw = reads.get_note_raw(conn, note_id)
        if raw is None:
            raise NotFound("Note not found.")
        return {"ok": True, "item": reads.note_row(raw)}

    @api.get("/client/{client_id}/infrastructure")
    def infrastructure(client_id: str) -> Dict[str, Any]:
        with rt.db() as conn:
            reads.require_client(conn, client_id)
            return {"ok": True, **infra.build_infrastructure(conn, config.channel, client_id=client_id,
                                                             today=rt.today(), server_tiles=True,
                                                             provider_available=rt.bams.provider.availability()[0])[client_id]}

    # ------------------------------------------------------------ writes
    @api.post("/client/save")
    def client_save(body: ClientSave) -> Dict[str, Any]:
        return services.save_client(rt, body)

    @api.post("/client/check-similar")
    def client_check_similar(body: CheckSimilar) -> Dict[str, Any]:
        return services.check_similar(rt, body)

    # ------------------------------------------------------------ account bulk import (Run 3)
    def _file_response(f: Dict[str, Any]) -> Response:
        return Response(content=f["data"], media_type=f["media"], headers={
            "Content-Disposition": f'attachment; filename="{f["filename"]}"', "Cache-Control": "no-store"})

    @api.get("/import/accounts/template")
    def import_template(format: str = Query("xlsx")) -> Response:
        return _file_response(import_service.template_file(format))

    @api.post("/import/accounts/inspect")
    async def import_inspect(request: Request) -> Dict[str, Any]:
        data = await request.body()                      # the 5 MiB route cap is enforced by BodyLimit
        item = await run_in_threadpool(import_service.inspect, rt, data, request.headers.get("x-file-name"))
        return {"ok": True, "item": item, "side_effects": []}

    @api.post("/import/accounts/apply")
    def import_apply(body: ImportApply) -> Dict[str, Any]:
        return {"ok": True, **import_service.apply(rt, body)}

    @api.get("/import/accounts/{import_id}/skipped.{fmt}")
    def import_skipped(import_id: str, fmt: str) -> Response:
        if fmt not in ("xlsx", "csv"):
            raise NotFound("Unknown API route.")
        return _file_response(import_service.skipped_file(rt, import_id, fmt))

    @api.get("/import/accounts/{import_id}")
    def import_plan(import_id: str) -> Any:
        if import_id in ("inspect", "apply"):            # write routes: GET is the wrong method
            resp = _json(405, MethodNotAllowed("Method not allowed on this path.", details={"allowed": ["POST"]}).body())
            resp.headers["Allow"] = "POST"
            return resp
        return {"ok": True, "item": import_service.get_plan(rt, import_id), "side_effects": []}

    @api.post("/client/delete")
    def client_delete(body: ClientDelete) -> Dict[str, Any]:
        return services.delete_client(rt, body)

    @api.post("/contact/save")
    def contact_save(body: ContactSave) -> Dict[str, Any]:
        return services.save_contact(rt, body)

    @api.post("/contact/delete")
    def contact_delete(body: DeleteBody) -> Dict[str, Any]:
        return services.delete_contact(rt, body)

    @api.post("/task/save")
    def task_save(body: TaskSave) -> Dict[str, Any]:
        return services.save_task(rt, body)

    @api.post("/task/archive")
    def task_archive(body: TaskArchive) -> Dict[str, Any]:
        return services.archive_task(rt, body)

    @api.post("/task/delete")
    def task_delete(body: DeleteBody) -> Dict[str, Any]:
        return services.delete_task(rt, body)

    @api.post("/note/save")
    def note_save(body: NoteSave) -> Dict[str, Any]:
        return services.save_note(rt, body)

    @api.post("/note/delete")
    def note_delete(body: DeleteBody) -> Dict[str, Any]:
        return services.delete_note(rt, body)

    @api.post("/data/backup")
    def data_backup(body: EmptyBody) -> Dict[str, Any]:
        return services.manual_backup(rt)

    @api.get("/data/backups")
    def data_backups(limit: int = Query(C.BACKUPS_DEFAULT_LIMIT, ge=1, le=200)) -> Dict[str, Any]:
        return {"ok": True, "items": rt.backups.list(limit), "backup_dir": str(config.backup_dir)}

    # ------------------------------------------------------------ BAMS monitoring (Run 4) and BAMS import
    bams_routes.register(api, rt)
    bams_routes.register_import(api, rt)
    ops_routes.register(api, rt)          # Run 5 Operations (replaces the 501 stub)

    # ------------------------------------------------------------ DEV-only routes: not registered in PROD
    if config.mode == "DEV":
        bams_routes.register_dev(api, rt)
        @api.post("/dev/reseed")
        def dev_reseed(body: DevReseed) -> Dict[str, Any]:
            return services.dev_reseed(rt, body.confirm)

    # ------------------------------------------------------------ 501 stubs (later phases)
    def _stub(prefix: str, phase: str) -> None:
        def handler(request: Request, rest: str = "") -> JSONResponse:
            err = NotImplementedYet(f"{request.method} {request.url.path} is planned for a later release ({phase}).",
                                    details={"phase": phase})
            return _json(501, err.body())
        api.add_api_route("/" + prefix, handler, methods=_ALL_METHODS, include_in_schema=False)
        api.add_api_route("/" + prefix + "/{rest:path}", handler, methods=_ALL_METHODS, include_in_schema=False)

    for prefix, phase in _STUB_PHASES.items():
        _stub(prefix, phase)

    @api.api_route("/{rest:path}", methods=_ALL_METHODS, include_in_schema=False)
    def api_not_found(request: Request, rest: str) -> JSONResponse:
        # QA-E1-3: a path that exists under another method is a 405 with Allow, not a 404.
        path = request.url.path
        allowed = set()
        for route in api.routes:
            methods = getattr(route, "methods", None)
            if (route.path.endswith("{rest:path}") or not methods or len(methods) >= len(_ALL_METHODS)  # type: ignore[attr-defined]
                    or not route.path_regex.match(path)):  # type: ignore[attr-defined]
                continue
            allowed |= set(methods)
        if allowed:
            if "GET" in allowed:
                allowed.add("HEAD")
            resp = _json(405, MethodNotAllowed("Method not allowed on this path.",
                                               details={"allowed": sorted(allowed)}).body())
            resp.headers["Allow"] = ", ".join(sorted(allowed))
            return resp
        return _json(404, NotFound("Unknown API route.").body())

    app.include_router(api)

    # ------------------------------------------------------------ compiled frontend + SPA fallback (D-13)
    web = config.web_dir

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(full_path: str):  # type: ignore[no-untyped-def]
        index = web / "index.html"
        if not index.is_file():
            return _json(404, NotFound("Frontend build not found (web/index.html).").body())
        if full_path:
            target = (web / full_path).resolve()
            if web.resolve() in target.parents and target.is_file():
                return FileResponse(target)
            if "." in Path(full_path).name:      # missing asset: a real 404, not the SPA shell
                return _json(404, NotFound("Not found.").body())
        return FileResponse(index, headers={"Cache-Control": "no-store"})

    return app

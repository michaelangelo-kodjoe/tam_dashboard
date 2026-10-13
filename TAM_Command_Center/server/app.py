"""FastAPI application factory. Routes are thin: validation -> service -> JSON. No SQL here."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import constants as C
from . import infra, reads, services
from .config import Config
from .errors import (AppError, ForbiddenOrigin, MethodNotAllowed, NotFound, NotImplementedYet, ValidationFailed)
from .logsetup import is_disconnect, log_connection_event, tail
from .runtime import Runtime
from .schemas import (ClientDelete, ClientSave, ContactSave, DeleteBody, DevReseed, EmptyBody, NoteSave,
                      SettingsSave, TaskArchive, TaskSave)
from .today import build_today

log = logging.getLogger("tam.api")

_STUB_PHASES = {
    "operations": "Phase 3: Operations",
    "bams": "Phase 4: BAMS",
    "export": "Phase 5: data portability",
    "import": "Phase 5: data portability",
    "data/reset": "Phase 5: data portability",
    "restore": "Phase 5: data portability",
    "context": "Phase 5: ChatGPT Bridge",
    "chat": "Phase 5: ChatGPT Bridge",
}
_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


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


def create_app(config: Config, *, acquire_lock: bool = True, clock: Any = None) -> FastAPI:
    rt = Runtime(config, acquire_lock=acquire_lock, clock=clock)
    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
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
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.url.path.startswith("/api") or response.headers.get("content-type", "").startswith("application/json"):
            response.headers["Cache-Control"] = "no-store"
        log.debug("%s %s -> %s (%.1f ms)", request.method, request.url.path, response.status_code,
                  (time.perf_counter() - t0) * 1000)
        return response

    if config.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_methods=["GET", "POST"],
                           allow_headers=["Content-Type"], allow_credentials=False)

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
                    "infrastructure": infra.build_infrastructure(conn, config.channel, include_metrics=False)}

    @api.get("/today")
    def today() -> Dict[str, Any]:
        with rt.db() as conn:
            return {"ok": True, **build_today(conn, rt.today())}

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

    @api.get("/client/{client_id}/infrastructure")
    def infrastructure(client_id: str) -> Dict[str, Any]:
        with rt.db() as conn:
            reads.require_client(conn, client_id)
            return {"ok": True, **infra.build_infrastructure(conn, config.channel, client_id=client_id)[client_id]}

    # ------------------------------------------------------------ writes
    @api.post("/client/save")
    def client_save(body: ClientSave) -> Dict[str, Any]:
        return services.save_client(rt, body)

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

    # ------------------------------------------------------------ DEV-only routes: not registered in PROD
    if config.mode == "DEV":
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
    def api_not_found(rest: str) -> JSONResponse:
        return _json(404, NotFound("Unknown API route.").body())

    app.include_router(api)

    # ------------------------------------------------------------ compiled frontend + SPA fallback (D-13)
    web = config.web_dir

    @app.get("/{full_path:path}", include_in_schema=False)
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

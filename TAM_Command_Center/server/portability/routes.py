"""HTTP routes for export and restore-from-file. Thin: validate -> service -> response. No SQL here."""
from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from ..errors import MethodNotAllowed, NotFound
from ..schemas import EmptyBody
from . import dbrestore, export, restore
from .schemas import DbFromBackup, DbRestoreApply, RestoreApply, RestoreRemove, RestoreTable, TableKey


def register(api: APIRouter, rt: Any) -> None:
    @api.get("/export/excel")
    def export_excel() -> Response:
        def build() -> bytes:
            with rt.db() as conn:
                return export.build_xlsx(conn, version=rt.config.version, channel=rt.config.mode,
                                         now=_dt.datetime.now(_dt.timezone.utc))
        data = build()
        name = export.excel_filename(_dt.datetime.now(), rt.config.mode)
        export.log.info("excel export: %d bytes", len(data))
        return Response(content=data, media_type=export.XLSX_MEDIA, headers={
            "Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @api.get("/export/database")
    def export_database() -> FileResponse:
        info = export.database_copy(rt)
        return FileResponse(info["path"], media_type="application/vnd.sqlite3", filename=info["filename"],
                            headers={"Cache-Control": "no-store"}, background=BackgroundTask(export._rm, info["path"]))

    # ------------------------------------------------------------ restore database (D-136..D-142)
    @api.post("/restore/database/inspect")
    async def db_inspect(request: Request) -> Dict[str, Any]:
        from ..importer.reader import display_file_name
        from urllib.parse import unquote
        declared = request.headers.get("content-length")
        path = await run_in_threadpool(dbrestore.begin_upload, rt, int(declared) if declared and declared.isdigit() else None)
        size = 0
        try:
            with path.open("wb") as fh:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > dbrestore.MAX_DB_BYTES:
                        break
                    fh.write(chunk)
        except BaseException:
            dbrestore._rm(path)
            raise
        name = display_file_name(unquote(request.headers.get("x-file-name") or "database.db"))
        item = await run_in_threadpool(dbrestore.inspect_written, rt, path, name, size)
        return {"ok": True, "item": item, "side_effects": []}

    @api.post("/restore/database/from-backup")
    def db_from_backup(body: DbFromBackup) -> Dict[str, Any]:
        return {"ok": True, "item": dbrestore.from_backup(rt, body.name), "side_effects": []}

    @api.post("/restore/database/apply")
    def db_apply(body: DbRestoreApply) -> Dict[str, Any]:
        return {"ok": True, **dbrestore.apply(rt, body.restore_id, body.confirm)}

    @api.post("/restore/database/{restore_id}/cancel")
    def db_cancel(restore_id: str, body: EmptyBody) -> Dict[str, Any]:
        return {"ok": True, "item": dbrestore.cancel(rt, restore_id), "side_effects": []}

    @api.get("/restore/database/{restore_id}")
    def db_get(restore_id: str) -> Dict[str, Any]:
        return {"ok": True, "item": dbrestore.get(rt, restore_id), "side_effects": []}

    # ------------------------------------------------------------ restore from file
    @api.post("/restore/inspect")
    async def restore_inspect(request: Request, session: Optional[str] = Query(None, max_length=64),
                              table: Optional[TableKey] = None) -> Dict[str, Any]:
        data = await request.body()                       # the 25 MiB cap is enforced by BodyLimit
        item = await run_in_threadpool(restore.inspect, rt, data, request.headers.get("x-file-name"), session, table)
        return {"ok": True, "item": item, "side_effects": []}

    @api.post("/restore/apply")
    def restore_apply(body: RestoreApply) -> Dict[str, Any]:
        return {"ok": True, **restore.apply(rt, body.restore_id, body.plan_hash, body.confirm)}

    @api.get("/restore/{restore_id}/skipped.{fmt}")
    def restore_skipped(restore_id: str, fmt: str) -> Response:
        if fmt not in ("xlsx", "csv"):
            raise NotFound("Unknown API route.")
        f = restore.skipped_file(rt, restore_id, fmt)
        return Response(content=f["data"], media_type=f["media"], headers={
            "Content-Disposition": f'attachment; filename="{f["filename"]}"', "Cache-Control": "no-store"})

    @api.post("/restore/{restore_id}/remove")
    def restore_remove(restore_id: str, body: RestoreRemove) -> Dict[str, Any]:
        return {"ok": True, "item": restore.remove(rt, restore_id, body.file_id), "side_effects": []}

    @api.post("/restore/{restore_id}/table")
    def restore_table(restore_id: str, body: RestoreTable) -> Dict[str, Any]:
        return {"ok": True, "item": restore.set_table(rt, restore_id, body.file_id, body.table), "side_effects": []}

    @api.get("/restore/{restore_id}")
    def restore_get(restore_id: str, table: Optional[TableKey] = None,
                    outcome: Optional[Literal["differs", "invalid"]] = None,
                    limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0)) -> Any:
        if restore_id in ("inspect", "apply"):
            from fastapi.responses import JSONResponse
            return JSONResponse(MethodNotAllowed("Method not allowed on this path.", details={"allowed": ["POST"]}).body(),
                                status_code=405, headers={"Allow": "POST", "Cache-Control": "no-store"})
        return {"ok": True, "item": restore.get_plan(rt, restore_id, table, outcome, limit, offset), "side_effects": []}

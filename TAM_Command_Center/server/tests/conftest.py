"""Test fixtures: each test gets its own temp app root, DEV database, backups and logs."""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]          # TAM_Command_Center/
sys.path.insert(0, str(ROOT))

from server.app import create_app          # noqa: E402
from server.config import load_config      # noqa: E402

TODAY = dt.date.today()


def d(off: int) -> str:
    return (TODAY + dt.timedelta(days=off)).isoformat()


def make_config(tmp_path: Path, *, prod: bool = False, seed: bool = False, extra_env=None, port: int = 8791):
    root = tmp_path / "app"
    root.mkdir(parents=True, exist_ok=True)
    (root / "VERSION.txt").write_text(f"version=0.1.0-test\nchannel={'prod' if prod else 'dev'}\n")
    env = {"LOCALAPPDATA": str(tmp_path / "localappdata"), "TAM_PORT": str(port),
           "TAM_DEV_SEED": "1" if seed else "0"}
    if not prod:
        env["TAM_DEV_MODE"] = "1"
    env.update(extra_env or {})
    return load_config(env, app_root=root)


class Api:
    """Thin wrapper over TestClient that asserts the {ok} envelope."""

    def __init__(self, client: TestClient, rt) -> None:
        self.c, self.rt = client, rt

    def get(self, path, **params):
        return self.c.get(path, params=params or None)

    def post(self, path, body=None):
        return self.c.post(path, json=body if body is not None else {})

    def ok(self, path, body=None, status=200):
        r = self.post(path, body)
        assert r.status_code == status, r.text
        j = r.json()
        assert j["ok"] is True
        return j

    def err(self, path, body, status, code):
        r = self.post(path, body)
        assert r.status_code == status, r.text
        j = r.json()
        assert j["ok"] is False and j["error"]["code"] == code, j
        return j["error"]

    def sql(self, sql, params=()):
        with self.rt.db() as conn:
            return [dict(r) for r in conn.execute(sql, params)]

    def exec(self, sql, params=()):
        with self.rt.db() as conn:
            conn.execute(sql, params)

    def audit(self, **where):
        clauses = " AND ".join(f"{k} = ?" for k in where) or "1=1"
        return self.sql(f"SELECT * FROM audit_events WHERE {clauses} ORDER BY id", tuple(where.values()))

    def mk_client(self, name="Acme Capital", **kw):
        return self.ok("/api/client/save", {"name": name, **kw})["item"]

    def mk_task(self, client_id=None, task="Do thing", **kw):
        return self.ok("/api/task/save", {"task": task, "client_id": client_id, **kw})["item"]


def _build(tmp_path, **kw):
    cfg = make_config(tmp_path, **kw)
    app = create_app(cfg)
    client = TestClient(app, base_url="http://127.0.0.1:8791", raise_server_exceptions=False)
    return Api(client, app.state.runtime), app


@pytest.fixture
def api(tmp_path):
    a, app = _build(tmp_path)
    yield a
    app.state.runtime.close()


@pytest.fixture
def seeded(tmp_path):
    a, app = _build(tmp_path, seed=True)
    yield a
    app.state.runtime.close()


@pytest.fixture
def build(tmp_path):
    made = []

    def _b(**kw):
        a, app = _build(tmp_path, **kw)
        made.append(app)
        return a
    yield _b
    for app in made:
        app.state.runtime.close()


def add_route(api: "Api", path: str, fn) -> None:
    """Register a test-only route ahead of the /api catch-all."""
    from fastapi.routing import APIRoute
    app = api.c.app
    app.router.routes.insert(0, APIRoute(path, fn, methods=["GET"]))

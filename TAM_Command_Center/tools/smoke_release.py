"""Release smoke test (PM T-42, spec sections 4 and 56). Runs on macOS/Linux/Windows.

    python tools/smoke_release.py --work DIR [--python PATH] [--keep]

Everything happens under --work (a scratch directory). HOME, USERPROFILE and
LOCALAPPDATA are redirected into it for every child process, so no real user data and
no real %LOCALAPPDATA% is ever read, created or modified.

Steps
 1. build the PROD zip and a DEV-preview zip
 2. archive audit: no db/-wal/-shm/dev_data/.venv/node_modules/frontend, schema.sql +
    migrations + queries present, VERSION channel, manifest hashes match every file
 3. unpack PROD zip to a clean dir, create a fresh venv, pip install requirements.txt
 4. PROD boot (channel=prod, test flags set on purpose): assert flags ignored, mode PROD,
    NO auto-seed (0 accounts), no /api/dev routes, DB only under the redirected LOCALAPPDATA
 5. a dev-channel tree refuses PROD mode (exit 3)
 6. DEV boot from the DEV-preview zip: TAM_DEV_MODE=1 TAM_BAMS_TEST_MODE=1, /api/state, seeded,
    DB under the unpacked dev_data only
 7. env_check.py for both modes, helper scripts
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
FAILS: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  [{'PASS' if cond else 'FAIL'}] {msg}")
    if not cond:
        FAILS.append(msg)


def run(cmd, env=None, cwd=None, timeout=600, quiet=False):
    p = subprocess.run([str(c) for c in cmd], env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if not quiet:
        out = (p.stdout + p.stderr).strip()
        if out:
            print("    " + out.replace("\n", "\n    "))
    return p


def free_port(preferred: int) -> int:
    for port in (preferred, 0):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", port))
            return s.getsockname()[1]
        except OSError:
            pass
        finally:
            s.close()
    raise RuntimeError("no free port")


def http_json(url: str, timeout=5):
    req = urllib.request.Request(url, headers={"Host": url.split("/")[2]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


def wait_up(port: int, proc: subprocess.Popen, secs=40):
    end = time.time() + secs
    while time.time() < end:
        if proc.poll() is not None:
            return False
        try:
            st, _ = http_json(f"http://127.0.0.1:{port}/api/health", 2)
            if st == 200:
                return True
        except Exception:
            time.sleep(0.4)
    return False


def start_server(py, app_dir: Path, env: dict, log: Path) -> subprocess.Popen:
    f = open(log, "w")
    return subprocess.Popen([str(py), "-m", "server"], cwd=str(app_dir), env=env, stdout=f, stderr=subprocess.STDOUT)


def stop(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def clean_env(work: Path, **extra) -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("TAM_") and k not in ("LOCALAPPDATA", "HOME", "USERPROFILE", "PYTHONPATH", "VIRTUAL_ENV")}
    home = work / "home"
    home.mkdir(parents=True, exist_ok=True)
    env.update({"HOME": str(home), "USERPROFILE": str(home), "LOCALAPPDATA": str(work / "LocalAppData"),
                "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})
    env.update(extra)
    return env


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    work = Path(a.work).resolve()
    real_home_marker = Path.home() / ".local" / "share" / "TAM_Command_Center"
    pre_existing = real_home_marker.exists()
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    dist = work / "dist"
    print(f"work dir: {work}\nbuild python: {a.python}")
    check(sys.version_info >= (3, 10), "runner python is 3.10+")

    print("\n[1] build")
    for ch in ("prod", "dev"):
        p = run([a.python, APP / "tools" / "build_release.py", "--channel", ch, "--out", dist])
        check(p.returncode == 0, f"build_release.py --channel {ch} exit 0")
    zprod = next(dist.glob("*_win.zip"))
    zdev = next(dist.glob("*_DEVPREVIEW.zip"))

    print("\n[2] archive audit")
    with zipfile.ZipFile(zprod) as z:
        names = z.namelist()
        check(z.testzip() is None, "zip integrity (testzip)")
        bad = [n for n in names if n.lower().endswith((".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3"))]
        check(not bad, f"no database files in the archive ({len(names)} entries)")
        for banned in ("/dev_data/", "/.venv/", "/node_modules/", "/frontend/", "/__pycache__/", "/tests/", "mock_data.json", "seed_mock.py"):
            check(not any(banned in "/" + n for n in names), f"archive has no {banned.strip('/')}")
        check(all(not n.startswith(("/", "..")) and ".." not in n.split("/") for n in names), "no absolute or traversal paths")
        for req in ("db/schema.sql", "db/migrate.py", "db/migrations/0001_initial.sql", "db/queries/today_queue.sql",
                    "web/index.html", "requirements.txt", "VERSION.txt", "BUILD_MANIFEST.txt", "README.txt", "VALIDATION.txt",
                    "Launch_TAM_Command_Center.bat", "Launch_DEV_Preview.bat", "Install_Dependency.bat",
                    "Check_PROD_Environment.bat", "Check_DEV_Environment.bat", "tools/env_check.py"):
            check(f"TAM_Command_Center/{req}" in names, f"present: {req}")
        queries = [n for n in names if "/db/queries/" in n and n.endswith(".sql")]
        migs = [n for n in names if "/db/migrations/" in n and n.endswith(".sql")]
        check(len(queries) == len(list((APP / "db" / "queries").glob("*.sql"))) and queries, f"all {len(queries)} query files shipped")
        check(len(migs) == len(list((APP / "db" / "migrations").glob("*.sql"))) and migs, f"all {len(migs)} migration files shipped")
        ver = z.read("TAM_Command_Center/VERSION.txt").decode()
        check("channel=prod" in ver, "VERSION.txt in the release says channel=prod")
        reqs = z.read("TAM_Command_Center/requirements.txt").decode()
        check("pytest" not in reqs and "pip-audit" not in reqs and "bandit" not in reqs, "requirements.txt has no test/audit tooling")
        check("uvloop" not in reqs and "websockets" not in reqs, "optional uvicorn extras (uvloop, websockets: no Windows wheel / py3.11+) are not pinned")
        check("fastapi==" in reqs and "uvicorn==" in reqs and "pydantic==" in reqs, "core pins present")
        manifest = z.read("TAM_Command_Center/BUILD_MANIFEST.txt").decode().splitlines()
        rows = [l.split("  ", 2) for l in manifest if len(l.split("  ", 2)) == 3 and len(l.split("  ", 2)[0]) == 64]
        listed = {r[2] for r in rows}
        shipped = {n.split("/", 1)[1] for n in names if n != "TAM_Command_Center/BUILD_MANIFEST.txt"}
        check(listed == shipped, f"manifest lists exactly the shipped files ({len(listed)})")
        okh = all(hashlib.sha256(z.read(f"TAM_Command_Center/{r[2]}")).hexdigest() == r[0] for r in rows)
        check(okh, "every SHA-256 in BUILD_MANIFEST.txt matches the archive bytes")
        bats = [n for n in names if n.endswith(".bat")]
        check(all(b"\r\n" in z.read(n) and b"\n" not in z.read(n).replace(b"\r\n", b"") for n in bats), f"{len(bats)} .bat files are CRLF")
        z.extractall(work / "prod")
    with zipfile.ZipFile(zdev) as z:
        z.extractall(work / "dev")
    papp, dapp = work / "prod" / "TAM_Command_Center", work / "dev" / "TAM_Command_Center"
    check("channel=dev" in (dapp / "VERSION.txt").read_text(), "DEV-preview package says channel=dev")

    print("\n[3] fresh venv + pip install requirements.txt (network)")
    venv = papp / ".venv"
    p = run([a.python, "-m", "venv", venv], quiet=True)
    check(p.returncode == 0, "venv created")
    vpy = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    p = run([vpy, "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", papp / "requirements.txt"], env=clean_env(work), timeout=900)
    check(p.returncode == 0, "pip install -r requirements.txt exit 0")
    p = run([vpy, "-m", "pip", "freeze"], quiet=True)
    print(f"    {len(p.stdout.split())} packages installed in the venv")
    p = run([vpy, "-m", "pip", "check"], quiet=True)
    check(p.returncode == 0, f"pip check: {p.stdout.strip()}")
    p = run([vpy, "-c", "import sys; print(sys.version.split()[0])"], quiet=True)
    print(f"    venv python {p.stdout.strip()}")

    print("\n[4] PROD boot from the prod zip (TAM_DEV_MODE=1 and TAM_BAMS_TEST_MODE=1 set ON PURPOSE; must be ignored)")
    port = free_port(8765)
    env = clean_env(work, TAM_DEV_MODE="1", TAM_BAMS_TEST_MODE="1", TAM_PORT=str(port))
    p = run([vpy, papp / "tools" / "env_check.py", "--mode", "prod"], env=clean_env(work, TAM_PORT=str(port)), quiet=True)
    print("    env_check --mode prod (full, BLPAPI strict):\n    " + p.stdout.strip().replace("\n", "\n    "))
    check(p.returncode == 1 and "BLPAPI unavailable" in p.stdout, "PROD env check FAILS closed when BLPAPI is missing (expected here)")
    p = run([vpy, papp / "tools" / "env_check.py", "--mode", "prod", "--core-only"], env=clean_env(work, TAM_PORT=str(port)), quiet=True)
    check(p.returncode == 0, "PROD env check --core-only passes (BLPAPI reported INFO)")
    p = run([vpy, papp / "tools" / "env_check.py", "--mode", "dev"], env=clean_env(work, TAM_DEV_MODE="1", TAM_BAMS_TEST_MODE="1"), quiet=True)
    check(p.returncode == 1 and "production-channel release" in p.stdout, "DEV env check on a prod-channel release FAILS (DEV not honoured)")
    proc = start_server(vpy, papp, env, work / "prod_server.log")
    try:
        up = wait_up(port, proc)
        check(up, f"PROD server answers /api/health on 127.0.0.1:{port}")
        if up:
            st, state = http_json(f"http://127.0.0.1:{port}/api/state")
            rt = state["runtime"]
            print(f"    /api/state runtime: mode={rt['mode']} channel={rt['channel']} version={rt['version']} schema={rt['schema_version']}")
            print(f"    db_path={rt['db_path']}")
            check(st == 200 and rt["mode"] == "PROD" and rt["channel"] == "prod", "mode PROD / channel prod despite TAM_DEV_MODE=1")
            check(len(state["accounts"]) == 0 and len(state["tasks"]) == 0, "PROD did NOT auto-seed (0 accounts, 0 tasks)")
            check(str(work / "LocalAppData") in rt["db_path"], "PROD DB path is under the redirected LOCALAPPDATA")
            st2, _ = http_json(f"http://127.0.0.1:{port}/api/dev/reseed")
            check(st2 in (404, 405), f"/api/dev/* not registered in PROD (status {st2})")
            st3, _ = http_json(f"http://127.0.0.1:{port}/openapi.json")
            check(st3 == 404, f"/openapi.json hidden in PROD (status {st3})")
            req = urllib.request.Request(f"http://127.0.0.1:{port}/")
            with urllib.request.urlopen(req, timeout=5) as r:
                check(r.status == 200 and b"<div id=\"root\"" in r.read(), "built web/ UI is served at /")
        check(not (papp / "dev_data").exists(), "no dev_data/ created in the PROD tree")
    finally:
        stop(proc)
    log = (work / "prod_server.log").read_text()
    logs = list((work / "LocalAppData").rglob("*.log"))
    txt = "\n".join(l.read_text(errors="replace") for l in logs)
    check("ignored TAM_DEV_MODE='1'" in txt and "ignored TAM_BAMS_TEST_MODE='1'" in txt, "PROD log records that both test flags were ignored")
    dbs = list((work / "LocalAppData").rglob("*.db"))
    print(f"    PROD DB created: {[str(d.relative_to(work)) for d in dbs]}")
    check(len(dbs) == 1 and dbs[0].name == "tam_command_center.db", "exactly one PROD DB, created empty in the temp LOCALAPPDATA")
    print("    prod server log (tail):\n    " + "\n    ".join(log.strip().splitlines()[-3:]) if log.strip() else "    (server stdout empty; logging goes to the log file)")

    print("\n[5] a dev-channel tree must refuse PROD mode")
    p = run([vpy, "-m", "server"], env=clean_env(work, TAM_PORT=str(free_port(8767))), cwd=dapp, timeout=60)
    check(p.returncode == 3, f"dev-channel build without TAM_DEV_MODE=1 exits 3 (got {p.returncode})")
    check(not (dapp / "dev_data").exists(), "refusal created no dev_data")

    print("\n[6] DEV boot from the DEV-preview package (TAM_DEV_MODE=1, TAM_BAMS_TEST_MODE=1)")
    dport = free_port(8766)
    denv = clean_env(work, TAM_DEV_MODE="1", TAM_BAMS_TEST_MODE="1", TAM_PORT=str(dport))
    p = run([vpy, dapp / "tools" / "env_check.py", "--mode", "dev"], env=denv, quiet=True)
    print("    env_check --mode dev:\n    " + p.stdout.strip().replace("\n", "\n    "))
    check(p.returncode == 0, "DEV env check passes on the dev-channel package")
    dproc = start_server(vpy, dapp, denv, work / "dev_server.log")
    try:
        up = wait_up(dport, dproc)
        check(up, f"DEV server answers /api/health on 127.0.0.1:{dport}")
        if up:
            st, state = http_json(f"http://127.0.0.1:{dport}/api/state")
            rt = state["runtime"]
            print(f"    /api/state: status={st} mode={rt['mode']} channel={rt['channel']} accounts={len(state['accounts'])} tasks={len(state['tasks'])} contacts={len(state['contacts'])}")
            check(st == 200 and rt["mode"] == "DEV" and rt["channel"] == "dev", "DEV mode/channel")
            check(len(state["accounts"]) > 0, "DEV DB auto-seeded with mock data")
            check(str(dapp / "dev_data") in rt["db_path"], "DEV DB lives in <app>/dev_data")
            st, today = http_json(f"http://127.0.0.1:{dport}/api/today")
            check(st == 200, "/api/today 200")
    finally:
        stop(dproc)
    check(not (work / "LocalAppData" / "TAM_Command_Center" / "tam_dev.db").exists(), "DEV wrote nothing into the (redirected) PROD folder")
    check(len(list((work / "LocalAppData").rglob("tam_dev.db"))) == 0, "no DEV DB under LOCALAPPDATA")

    print("\n[7] real user data untouched")
    check(pre_existing or not real_home_marker.exists(), f"{real_home_marker} was not created")

    print("\n" + ("SMOKE TEST: PASS" if not FAILS else f"SMOKE TEST: FAIL ({len(FAILS)})"))
    for f in FAILS:
        print("  failed:", f)
    if not a.keep:
        pass  # scratch dir is left for inspection; it lives under the session scratchpad
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

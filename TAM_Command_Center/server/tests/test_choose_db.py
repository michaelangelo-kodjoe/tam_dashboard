"""Unit tests for tools/choose_db.py and tools/install_stamp.py (stdlib helpers used by the Windows .bat files)."""
import importlib.util
import sys
from pathlib import Path

import pytest

from server.config import validate_db_name
from server.errors import StartupRefused

TOOLS = Path(__file__).resolve().parents[2] / "tools"


def _load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f"{name}.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


cd = _load("choose_db")
st = _load("install_stamp")

CASES = ["a", "tam_command_center", "x" * 40, "x" * 41, "", "my db", "a.b", "a/b", "..", "a\\b", "con", "NUL", "Com1",
         "lpt9", "ok-name_1", "café", "a b", "x.db"]


@pytest.mark.parametrize("name", CASES)
def test_rules_match_server(name):
    try:
        validate_db_name(name)
        server_ok = True
    except StartupRefused:
        server_ok = False
    assert (cd.validate(name) is None) == server_ok


def feeder(answers, log=None):
    it = iter(answers)

    def reader(prompt, timeout):
        a = next(it)
        return a
    return reader


def test_enter_keeps_last(tmp_path):
    (tmp_path / "alpha.db").write_bytes(b"x")
    cd.remember(tmp_path, "alpha")
    assert cd.choose(tmp_path, feeder([""]), lambda *_: None) == "alpha"


def test_no_console_keeps_last_default(tmp_path):
    assert cd.choose(tmp_path, feeder([None]), lambda *_: None) == "tam_command_center"


def test_number_pick(tmp_path):
    for n in ("b", "a"):
        (tmp_path / f"{n}.db").write_bytes(b"x")
    assert cd.choose(tmp_path, feeder(["2"]), lambda *_: None) == "b"  # sorted: a, b, then default (not created)


def test_bad_input_reprompts(tmp_path):
    assert cd.choose(tmp_path, feeder(["zz", "9", ""]), lambda *_: None) == "tam_command_center"


def test_new_name_validation_and_existing_refused(tmp_path):
    (tmp_path / "keep.db").write_bytes(b"x")
    out = []
    # invalid, existing-without-confirm, then valid new
    r = feeder(["N", "bad name", "keep", "no", "Fresh_1"])
    assert cd.choose(tmp_path, r, out.append) == "Fresh_1"
    assert any("already exists" in s for s in out) and any("Not accepted" in s for s in out)


def test_new_name_open_existing_confirmed(tmp_path):
    (tmp_path / "Keep.db").write_bytes(b"x")
    assert cd.choose(tmp_path, feeder(["N", "keep", "open"]), lambda *_: None) == "Keep"


def test_new_blank_cancels_to_last(tmp_path):
    assert cd.choose(tmp_path, feeder(["N", ""]), lambda *_: None) == "tam_command_center"


def test_ignores_odd_files_and_never_touches_dbs(tmp_path):
    (tmp_path / "a.db").write_bytes(b"x")
    (tmp_path / "bad name.db").write_bytes(b"x")
    (tmp_path / "a.db-wal").write_bytes(b"x")
    (tmp_path / "sub.db").mkdir()
    assert cd.existing(tmp_path) == ["a"]
    before = sorted(p.name for p in tmp_path.iterdir())
    cd.choose(tmp_path, feeder(["N", "newone"]), lambda *_: None)
    assert sorted(p.name for p in tmp_path.iterdir()) == before  # choosing creates nothing


def test_last_file_only_written_on_valid(tmp_path, monkeypatch):
    with pytest.raises(ValueError):
        cd.remember(tmp_path, "bad name")
    assert not (tmp_path / "last_database.txt").exists()
    (tmp_path / "last_database.txt").write_text("../evil\n")
    assert cd.last_used(tmp_path) == "tam_command_center"


def test_main_writes_out_and_last(tmp_path, monkeypatch):
    monkeypatch.setattr(cd, "read_line", lambda p, t: "N" if "choice" in p else "Brand_New")
    monkeypatch.setattr(cd, "choose", lambda d: "Brand_New")
    out = tmp_path / "o.txt"
    assert cd.main(["run", "--dir", str(tmp_path / "d"), "--out", str(out)]) == 0
    assert out.read_text().strip() == "Brand_New"
    assert (tmp_path / "d" / "last_database.txt").read_text().strip() == "Brand_New"


def test_stamp_ensure_is_import_driven(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(st, "STAMP", tmp_path / ".install_stamp")
    monkeypatch.setattr(st, "current_hash", lambda: "abc123")
    monkeypatch.setattr(st, "missing_modules", lambda: [])
    assert st.ensure() == 0  # no stamp: still no reinstall, stamp rewritten
    assert (tmp_path / ".install_stamp").read_text().strip() == "abc123"
    (tmp_path / ".install_stamp").write_text("deadbeef\n")
    assert st.ensure() == 0 and (tmp_path / ".install_stamp").read_text().strip() == "abc123"
    monkeypatch.setattr(st, "missing_modules", lambda: ["openpyxl"])
    assert st.ensure() == 1 and "openpyxl" in capsys.readouterr().out

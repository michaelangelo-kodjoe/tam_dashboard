"""Static lint for the Windows .bat files (they cannot be executed on macOS).

Heuristic, line-based. It catches the common cmd.exe mistakes; it does NOT prove
the scripts work. Exit 0 = no ERROR findings.

Usage: python tools/lint_bat.py [file.bat ...]   (default: all *.bat in the app root and tools/)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ERRCHK = re.compile(r'if\s+(not\s+)?errorlevel|set\s+"RC=%ERRORLEVEL%"|if\s+"%RC%"|goto\b|exit\s+/b', re.I)
EXTERNAL = re.compile(r'^(call\s+|"%|python\b|py\b|where\b|pushd\b|where\s)', re.I)
UNQUOTED_PATHVARS = ("%CD%", "%TAM_PYTHON%", "%TAM_PY_EXE%")


def lint(path: Path, is_helper: bool) -> list[tuple[str, int, str]]:
    out: list[tuple[str, int, str]] = []
    raw = path.read_bytes()
    text = raw.decode("utf-8", errors="strict")
    if any(ord(c) > 127 for c in text):
        out.append(("ERROR", 0, "non-ASCII character (code page hazards)"))
    if raw.startswith(b"\xef\xbb\xbf"):
        out.append(("ERROR", 1, "UTF-8 BOM breaks the first line in cmd.exe"))
    lf_only = b"\n" in raw.replace(b"\r\n", b"")
    if lf_only:
        out.append(("WARN", 0, "bare LF line endings (build_release.py converts to CRLF; labels/goto need CRLF)"))
    lines = text.splitlines()
    code = [(i + 1, l) for i, l in enumerate(lines)]
    first = next((l for _, l in code if l.strip()), "")
    if first.strip().lower() != "@echo off":
        out.append(("ERROR", 1, "first statement must be @echo off"))
    body = "\n".join(l for _, l in code if not l.strip().lower().startswith("rem"))
    if not is_helper:
        if not re.search(r"^setlocal\b", body, re.M | re.I):
            out.append(("ERROR", 0, "no setlocal (variables would leak into the caller's shell)"))
        if "%~dp0" not in body:
            out.append(("ERROR", 0, "does not anchor to %~dp0 (breaks when run from another directory)"))
        if "popd" not in body or "pushd" not in body:
            out.append(("ERROR", 0, "pushd/popd pair missing (UNC paths and cwd restore)"))
    labels = {m.group(1).lower() for l in lines if (m := re.match(r"^:([A-Za-z0-9_]+)", l.strip()))}
    for n, l in code:
        s = l.strip()
        low = s.lower()
        if low.startswith("rem") or not s:
            continue
        for m in re.finditer(r"(?:goto|call)\s+:([A-Za-z0-9_]+)", s, re.I):
            if m.group(1).lower() not in labels:
                out.append(("ERROR", n, f"undefined label :{m.group(1)}"))
        if re.match(r"^set\s+[^\"/]", s, re.I) and not re.match(r"^set\s+/", s, re.I):
            out.append(("ERROR", n, "set without quotes around NAME=value (trailing-space / special-character hazard)"))
        if s.endswith("(") or s.startswith("(") or s == ")":
            out.append(("WARN", n, "parenthesised block: any %var% containing ')' (e.g. Program Files (x86)) breaks it"))
        for v in UNQUOTED_PATHVARS:
            for m in re.finditer(re.escape(v), s):
                before = s[: m.start()]
                if before.count('"') % 2 == 0 and not low.startswith("echo") and not low.startswith("set"):
                    out.append(("ERROR", n, f"{v} used outside double quotes (spaces in path)"))
        if re.search(r'%~dp0"', s) and not low.startswith(("pushd", "cd", "echo", "set")):
            out.append(("ERROR", n, '"%~dp0" passed as an argument: trailing backslash escapes the closing quote'))
        if re.match(r"^exit(\s*$|\s+[^/\s])", low):
            out.append(("ERROR", n, "bare 'exit' closes the console; use exit /b"))
        if "%ERRORLEVEL%" in s and not re.search(r'set\s+"RC=%ERRORLEVEL%"', s):
            out.append(("WARN", n, "%ERRORLEVEL% used outside the set RC= idiom"))
        if EXTERNAL.match(s) and not low.startswith(("call :",)):
            if low.startswith("echo"):
                continue
            nxt = [t.strip() for _, t in code[n : n + 2] if t.strip()]
            if not (nxt and ERRCHK.search(nxt[0])) and not low.endswith("exit /b 1"):
                if "if errorlevel" in low or ">nul" in low and low.startswith("where"):
                    pass
                out.append(("ERROR", n, f"no errorlevel check after: {s[:60]}"))
    for lab in sorted(labels):
        if not re.search(rf"(goto|call)\s+:{re.escape(lab)}\b", body, re.I) and lab not in ("done",):
            out.append(("WARN", 0, f"label :{lab} is never referenced"))
    last = [l.strip() for _, l in code if l.strip()][-1].lower() if code else ""
    if not (last.startswith(("exit /b", "endlocal")) or "exit /b" in last or last.startswith("goto")):
        out.append(("ERROR", len(lines), "script does not end with exit /b or goto"))
    return out


def main(argv: list[str]) -> int:
    files = [Path(a) for a in argv] or sorted(ROOT.glob("*.bat")) + sorted((ROOT / "tools").glob("*.bat"))
    errors = 0
    for f in files:
        res = lint(f, is_helper=f.name.startswith("_"))
        e = sum(1 for r in res if r[0] == "ERROR")
        errors += e
        print(f"{f.relative_to(ROOT) if f.is_absolute() and ROOT in f.parents else f}: {e} error(s), {len(res) - e} warning(s)")
        for lvl, n, msg in res:
            print(f"   {lvl:<5} line {n}: {msg}")
    print(f"TOTAL: {errors} error(s) across {len(files)} file(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

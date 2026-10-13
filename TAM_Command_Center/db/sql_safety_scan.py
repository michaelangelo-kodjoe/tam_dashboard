"""SQL safety scan: finds any use of SQLite's REPLACE conflict algorithm and
equivalent destructive "replace" writes (QA-1-2, QA-2-2, QA-3-1/2, QA-4-1/2/3).

REPLACE resolves conflicts by deleting rows: ON DELETE CASCADE fires, and rows
that clash on secondary keys vanish without an audit row. It is BANNED in every
spelling (03_DATA_MODEL.md §2.1). The INSERT side cannot be blocked by triggers
without also breaking legitimate ON CONFLICT DO UPDATE / DO NOTHING upserts
(QA-2-1), so this scanner is the load-bearing control for that side. db/tests
runs it over the whole TAM_Command_Center tree. CI, the backend and the
deployment agent may also run:

    python db/sql_safety_scan.py [root]               # exit 1 and list offenders
    python db/sql_safety_scan.py --list-allow [root]  # list every allow marker (QA 3.2 review)

How a file is examined
  1. Decoding: BOM-aware (UTF-8-SIG, UTF-16 LE/BE, UTF-32). Without a BOM, a
     file with many NUL bytes is decoded as UTF-16 (Windows editors write these);
     otherwise strict UTF-8 is tried, falling back to latin-1. Nothing is
     silently dropped (QA-4-2).
  2. A small per-language lexer removes REAL comments only, never text inside
     string literals (QA-3-1b):
       py  : '#'                       js/ts : '//' and '/* */'
       sql : '--' and '/* */'; the CONTENTS of single-quoted SQL literals are
             dropped as well, because in a .sql file they are data, never code
             (QA-4-3 F10)
       sh/ps1 : '#' at the start of a word (+ '<# #>' blocks in PowerShell)
       bat : whole 'REM' / '::' lines
  3. String seams are erased: quotes, backticks, '+' and ',' are removed;
     backslash-newline and escaped \\n / \\t become spaces; whitespace collapses.
     Split, concatenated and multi-line spellings become one matchable phrase.
     Every kept character remembers its source line.
  4. Patterns (case-insensitive) are matched on the normalised text. TABLE is
     ANY non-space token, so placeholders match: {table}, {}, {0}, %s, ${t},
     "t", [t], `t`, main.t, or a variable joined with '+' (QA-4-1):
       INSERT OR REPLACE INTO ...
       UPDATE OR REPLACE TABLE SET ...
       REPLACE INTO TABLE [AS alias] ( | VALUES | SELECT | DEFAULT | WITH   (not after '.')
       ON CONFLICT REPLACE                      (DDL)
       prefix_with( [text(] OR REPLACE          (SQLAlchemy)
       *on_conflict*=REPLACE                    (SQLAlchemy sqlite_on_conflict*)
       .on_conflict_replace( / .on_conflict( [action=] replace   (peewee)
       Model.replace( kw= | ** ) / .replace_many(                 (peewee; .py only;
                                                 Capitalised receiver, so datetime.replace(hour=0) is clean)
       replace=True                             (sqlite-utils insert/insert_all; .py only)
       .orReplace(                              (Kysely)
       if_exists = replace / if_exists: replace (pandas to_sql, incl. dict-passed options)
       bare 'OR REPLACE' in .sql files, unless followed by '(' (the SQL replace() function)
  5. A finding is exempt only if one of its source lines carries the marker
     'sql-safety: allow <reason>' with a non-empty reason (at least 3
     characters). A bare marker does NOT exempt anything (QA-4-2 E11). Every
     marker is listed by --list-allow for QA review.

Scope: .py .pyw .pyi .sql .ts .tsx .js .jsx .mjs .cjs .sh .bash .zsh .ps1
.psm1 .bat .cmd. Skips are ANCHORED to the scan root: 'web/' (compiled assets),
'db/tests/' (deliberate hazard demonstrations and the scanner corpus),
'frontend/dist/'; plus vendor/tool dirs at any depth: node_modules, .venv,
venv, __pycache__, .git. This file itself is exempt (it must name the patterns).

Accepted false positives (fail closed; use the allow marker with a reason):
UI copy or string data that literally reads like a statement, e.g. "Insert or
replace into the list", "Replace into list (3 items)", or a Python/JS string
"Do not REPLACE INTO prod (seriously)". Inside .sql files, single-quoted data
is never flagged.
Known limit: a statement whose KEYWORDS are assembled at runtime
("INSERT OR %s INTO" % verb, f"{verb} INTO") cannot be seen statically. The
data contract forbids that pattern; reviewers check it in QA 3.2.
Python 3.9+, stdlib only.
"""
from __future__ import annotations

import codecs
import re
import sys
from pathlib import Path
from typing import List, Optional, Tuple

SCAN_SUFFIXES = {".py", ".pyw", ".pyi", ".sql", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
                 ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd"}
SKIP_ROOT_PATHS = ("web", "db/tests", "frontend/dist")            # anchored to the scan root
SKIP_ANY_DEPTH = {"node_modules", ".venv", "venv", "__pycache__", ".git"}  # vendor/tool dirs only
ALLOW_RE = re.compile(r"sql-safety:\s*allow\b[\s:(\[\-]*(?P<reason>[^\s)\]].{2,})", re.I)
BARE_ALLOW_RE = re.compile(r"sql-safety:\s*allow\b", re.I)

_I = re.I
_T = r"\S+"                                   # table token: any non-space token, placeholders included
_COMMON = [
    re.compile(r"\bINSERT\s+OR\s+REPLACE\s+INTO\b", _I),
    re.compile(rf"\bUPDATE\s+OR\s+REPLACE\s+{_T}\s+SET\b", _I),
    re.compile(rf"(?<![.\w])REPLACE\s+INTO\s+{_T}?\s*(?:AS\s+\S+\s+)?(?:\(|VALUES\b|SELECT\b|DEFAULT\b|WITH\b)", _I),
    re.compile(r"\bON\s+CONFLICT\s+REPLACE\b", _I),
    re.compile(r"\bprefix_with\s*\(\s*(?:text\s*\(\s*)?OR\s+REPLACE\b", _I),
    re.compile(r"on_conflict\w*\s*=\s*REPLACE\b", _I),
    re.compile(r"\.on_conflict_replace\s*\(", _I),
    re.compile(r"\.on_conflict\s*\(\s*(?:action\s*=\s*)?replace\b", _I),
    re.compile(r"\.orReplace\s*\(", _I),
    re.compile(r"\bif_exists\s*[=:]\s*replace\b", _I),
]
_PY_ONLY = [
    re.compile(r"\b[A-Z]\w*\.replace\s*\(\s*(?:\*\*|[A-Za-z_]\w*\s*=(?!=))"),   # peewee Model.replace(...)
    re.compile(r"\.replace_many\s*\(", _I),                                     # peewee
    re.compile(r"\breplace\s*=\s*True\b"),                                       # sqlite-utils
]
_SQL_ONLY = [re.compile(r"\bOR\s+REPLACE\b(?!\s*\()", _I)]


# ----------------------------------------------------------------------------- decoding

def read_source(path: Path) -> str:
    """Decode without silently dropping content (UTF-16 .sql files from Windows editors)."""
    data = path.read_bytes()
    for bom, enc in ((codecs.BOM_UTF32_LE, "utf-32-le"), (codecs.BOM_UTF32_BE, "utf-32-be"),
                     (codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF16_LE, "utf-16-le"),
                     (codecs.BOM_UTF16_BE, "utf-16-be")):
        if data.startswith(bom):
            return data[len(bom):].decode(enc, errors="replace")
    if data and data.count(b"\x00") > len(data) // 4:          # BOM-less UTF-16
        enc = "utf-16-le" if data[1:2] == b"\x00" else "utf-16-be"
        return data.decode(enc, errors="replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


# ----------------------------------------------------------------------------- lexer

def _lang(suffix: str) -> str:
    if suffix in {".py", ".pyw", ".pyi"}:
        return "py"
    if suffix == ".sql":
        return "sql"
    if suffix in {".sh", ".bash", ".zsh"}:
        return "sh"
    if suffix in {".ps1", ".psm1"}:
        return "ps1"
    if suffix in {".bat", ".cmd"}:
        return "bat"
    return "js"


def strip_comments(text: str, suffix: str) -> List[Tuple[str, int]]:
    """Return kept characters with their 1-based source line; real comments removed."""
    lang = _lang(suffix)
    out: List[Tuple[str, int]] = []
    if lang == "bat":
        for ln, raw in enumerate(text.split("\n"), start=1):
            if not re.match(r"\s*(?:@?rem\b|::)", raw, re.I):
                out.extend((c, ln) for c in raw)
            out.append(("\n", ln))
        return out
    i, n, line = 0, len(text), 1
    quote: Optional[str] = None          # active string delimiter

    def skip_to_eol(k: int) -> int:
        while k < n and text[k] != "\n":
            k += 1
        return k

    while i < n:
        ch = text[i]
        if quote is None:
            if lang == "py" and ch == "#":
                i = skip_to_eol(i)
                continue
            if lang in ("sh", "ps1") and ch == "#" and (i == 0 or text[i - 1].isspace() or text[i - 1] == ";"):
                i = skip_to_eol(i)
                continue
            if lang == "sql" and text.startswith("--", i):
                i = skip_to_eol(i)
                continue
            if lang == "js" and text.startswith("//", i):
                i = skip_to_eol(i)
                continue
            block = ("/*", "*/") if lang in ("sql", "js") else ("<#", "#>") if lang == "ps1" else None
            if block and text.startswith(block[0], i):
                j = text.find(block[1], i + 2)
                j = n if j < 0 else j + 2
                line += text.count("\n", i, j)
                out.append((" ", line))
                i = j
                continue
            if lang == "py" and text.startswith(('"""', "'''"), i):
                quote = text[i:i + 3]
            elif ch in ("'", '"') or (lang == "js" and ch == "`"):
                quote = ch
            out.append((ch, line))
            i += len(quote) if quote else 1
            if quote and len(quote) == 3:
                out.extend((c, line) for c in quote[1:])
            if ch == "\n":
                line += 1
            continue
        # ---- inside a string literal
        if ch == "\\" and lang in ("py", "js", "sh") and i + 1 < n:
            out.append((ch, line))
            out.append((text[i + 1], line))
            if text[i + 1] == "\n":
                line += 1
            i += 2
            continue
        if lang == "sql" and quote == "'" and text.startswith("''", i):
            i += 2                        # escaped quote inside SQL data literal: dropped with the data
            continue
        if text.startswith(quote, i):
            out.extend((c, line) for c in quote)
            i += len(quote)
            quote = None
            continue
        if ch == "\n" and lang in ("py", "js") and quote in ("'", '"'):
            quote = None                 # unterminated single-line string: recover
        if ch == "\n":
            out.append(("\n", line))     # keep line structure even inside dropped SQL data
            line += 1
        elif not (lang == "sql" and quote == "'"):
            out.append((ch, line))       # SQL single-quoted literal = data: contents dropped (QA-4-3)
        i += 1
    return out


def normalise(chars: List[Tuple[str, int]]) -> Tuple[str, List[int]]:
    """Erase string seams and collapse whitespace; keep a per-char source line map."""
    text_chars: List[str] = []
    lines: List[int] = []
    i, n = 0, len(chars)
    while i < n:
        ch, ln = chars[i]
        nxt = chars[i + 1][0] if i + 1 < n else ""
        if ch == "\\" and nxt in ("n", "t", "r", "\n"):
            ch, i = " ", i + 1
        elif ch in "\"'`+,":
            ch = " "
        if ch.isspace():
            if text_chars and text_chars[-1] == " ":
                i += 1
                continue
            ch = " "
        text_chars.append(ch)
        lines.append(ln)
        i += 1
    return "".join(text_chars), lines


def _patterns(suffix: str) -> list:
    lang = _lang(suffix)
    return _COMMON + (_PY_ONLY if lang == "py" else []) + (_SQL_ONLY if lang == "sql" else [])


def find_violations(text: str, suffix: str) -> List[str]:
    """Findings as 'line N: ...context...' strings (empty list = clean)."""
    raw_lines = text.splitlines()
    norm, line_of = normalise(strip_comments(text, suffix))
    spans = sorted((m.start(), m.end()) for p in _patterns(suffix) for m in p.finditer(norm))
    merged: List[List[int]] = []
    for a, b in spans:  # one finding per statement, even when several patterns overlap
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    hits = []
    for a, b in merged:
        src = [ln for ln in range(line_of[a], line_of[b - 1] + 1) if 0 < ln <= len(raw_lines)]
        if any(ALLOW_RE.search(raw_lines[ln - 1]) for ln in src):
            continue
        bare = any(BARE_ALLOW_RE.search(raw_lines[ln - 1]) for ln in src)
        note = " [allow marker ignored: a reason is required]" if bare else ""
        hits.append(f"line {line_of[a]}: ...{norm[max(0, a - 30): b + 30].strip()}...{note}")
    return hits


def _skipped(rel: Path) -> bool:
    parts = rel.parts
    if any(p in SKIP_ANY_DEPTH for p in parts[:-1]):
        return True
    posix = rel.as_posix()
    return any(posix == p or posix.startswith(p + "/") for p in SKIP_ROOT_PATHS)


def _files(root: Path):
    me = Path(__file__).resolve()
    for f in sorted(root.rglob("*")):
        if f.is_file() and f.suffix.lower() in SCAN_SUFFIXES and f.resolve() != me \
                and not _skipped(f.relative_to(root)):
            yield f


def scan(root: Path) -> List[str]:
    offenders = []
    for f in _files(root):
        for hit in find_violations(read_source(f), f.suffix.lower()):
            offenders.append(f"{f.relative_to(root).as_posix()}: {hit}")
    return offenders


def list_allow_markers(root: Path) -> List[str]:
    """Every allow marker in scope, with its reason (or MISSING), for QA 3.2 review."""
    found = []
    for f in _files(root):
        for n, line in enumerate(read_source(f).splitlines(), start=1):
            if BARE_ALLOW_RE.search(line):
                m = ALLOW_RE.search(line)
                reason = m.group("reason").strip() if m else "MISSING (marker has no effect)"
                found.append(f"{f.relative_to(root).as_posix()}:{n}: reason: {reason}")
    return found


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--list-allow":
        root = Path(args[1]) if len(args) > 1 else Path(__file__).resolve().parents[1]
        markers = list_allow_markers(root)
        for m in markers:
            print(m)
        print(f"sql_safety_scan: {len(markers)} allow marker(s) under {root}")
        sys.exit(0)
    root = Path(args[0]) if args else Path(__file__).resolve().parents[1]
    found = scan(root)
    for o in found:
        print(o)
    print(f"sql_safety_scan: {len(found)} violation(s) under {root}")
    sys.exit(1 if found else 0)

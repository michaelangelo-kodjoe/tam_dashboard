"""Restore file readers: whole-workbook (.xlsx) and single-table (.csv). Reuses the Run 3/4 safety layers
(`detect_format`, `check_zip`, decoding and delimiter sniffing, formula/error cell types). Nothing is evaluated,
nothing is written to disk. Cells stay raw here; typing and validation happen in the planner."""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from ..importer import reader as R
from ..importer.reader import CellError, Formula, _bad, _cell_value, _is_blank
from . import tables as T
from .export import unguard

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_SHEET_ROWS = 10_000
MAX_TOTAL_ROWS = 50_000
MAX_CSV_FILES = 9
_CSV_ROW_CAP = MAX_SHEET_ROWS + 1


@dataclass
class RawRow:
    n: int                                  # row number in the file (header = 1)
    cells: Dict[str, Any]                   # header (casefold) -> raw cell


@dataclass
class Sheet:
    headers: List[str]                      # as written
    rows: List[RawRow]
    unknown: List[str] = field(default_factory=list)


@dataclass
class Workbook:
    about: Dict[str, str]
    sheets: Dict[str, Sheet]                # table key -> sheet
    warnings: List[Dict[str, str]]


def _norm_header(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v)).strip().casefold() if v is not None and not isinstance(v, (Formula, CellError)) else ""


def _read_cells(headers_cf: List[str], rows: List[Tuple[int, List[Any]]]) -> List[RawRow]:
    out: List[RawRow] = []
    for n, vals in rows:
        cells = {h: (vals[i] if i < len(vals) else None) for i, h in enumerate(headers_cf) if h}
        if all(_is_blank(v) for v in cells.values()):
            continue
        out.append(RawRow(n, cells))
        if len(out) > MAX_SHEET_ROWS:
            raise _bad("too_many_rows", f"A sheet has more than {MAX_SHEET_ROWS} rows. Split the file and restore it in parts.",
                       limit=MAX_SHEET_ROWS)
    return out


def _clean_str(v: Any) -> Any:
    return unguard(v) if isinstance(v, str) and not isinstance(v, (Formula, CellError)) else v


# ------------------------------------------------------------------------------------------------ xlsx
def read_workbook(data: bytes) -> Workbook:
    zf = R.check_zip(data)
    zf.close()
    openpyxl = R._load_openpyxl()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
    except Exception as exc:  # noqa: BLE001 - any parser failure on an untrusted file is "corrupt"
        raise _bad("corrupt", "The workbook is damaged and cannot be read.") from exc
    try:
        names = {n.strip().casefold(): n for n in wb.sheetnames}
        if T.ABOUT_SHEET.casefold() not in names:
            raise _bad("not_an_export", "This workbook is not an export from this app (the About sheet is missing).")
        about: Dict[str, str] = {}
        for row in wb[names[T.ABOUT_SHEET.casefold()]].iter_rows(min_row=2, max_row=200, max_col=2):
            k, v = _cell_value(row[0]), (_cell_value(row[1]) if len(row) > 1 else None)
            if isinstance(k, str) and not isinstance(k, (Formula, CellError)) and k.strip():
                about[k.strip().casefold()] = "" if v is None or isinstance(v, (Formula, CellError)) else str(v).strip()
        sheets: Dict[str, Sheet] = {}
        warnings: List[Dict[str, str]] = []
        total = 0
        for cf, real in names.items():
            t = T.BY_SHEET.get(cf)
            if t is None:
                if cf != T.ABOUT_SHEET.casefold():
                    warnings.append({"code": "unknown_sheet", "text": f'Sheet "{R._clip(real, 30)}" is ignored.'})
                continue
            ws = wb[real]
            try:
                header = next(ws.iter_rows(min_row=1, max_row=1, max_col=R.MAX_HEADER_COLS), ())
            except StopIteration:
                header = ()
            hv = [_cell_value(c) for c in header]
            hcf = [_norm_header(v) for v in hv]
            _check_headers(t, hcf, real)
            raw = []
            for i, row in enumerate(ws.iter_rows(min_row=2, max_row=MAX_SHEET_ROWS + 2, max_col=len(hcf)), start=2):
                raw.append((i, [_clean_str(_cell_value(c)) for c in row]))
            rows = _read_cells(hcf, raw)
            total += len(rows)
            if total > MAX_TOTAL_ROWS:
                raise _bad("too_many_rows", f"The workbook has more than {MAX_TOTAL_ROWS} rows in total.", limit=MAX_TOTAL_ROWS)
            known = t.by_header()
            sheets[t.key] = Sheet([str(v) for v in hv if v is not None], rows,
                                  [str(v) for v, h in zip(hv, hcf) if h and h not in known])
            for u in sheets[t.key].unknown:
                warnings.append({"code": "unknown_column", "text": f'Sheet {t.sheet}: column "{R._clip(u, 30)}" is ignored.'})
        if not sheets:
            raise _bad("not_an_export", "This workbook is not an export from this app (no data sheets were found).")
        return Workbook(about, sheets, warnings)
    finally:
        wb.close()


def _check_headers(t: T.Table, hcf: List[str], label: str) -> None:
    dup = {h for h in hcf if h and hcf.count(h) > 1}
    if dup:
        raise _bad("header_duplicate", f'Sheet {label}: the column "{sorted(dup)[0]}" appears twice in row 1.')
    missing = [c.header for c in t.cols if c.required and c.header.casefold() not in hcf]
    if missing:
        raise _bad("header_missing", f"Sheet {label}: required column(s) missing: {', '.join(missing)}.", missing=missing,
                   sheet=label)


# ------------------------------------------------------------------------------------------------ csv
@dataclass
class CsvFile:
    headers: List[str]
    headers_cf: List[str]
    rows: List[RawRow]
    encoding: str
    delimiter: str
    unknown_cache: List[str] = field(default_factory=list)


def read_csv_file(data: bytes) -> CsvFile:
    if b"\x00" in data and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise _bad("not_csv", "This does not look like a text CSV file.")
    try:
        text, enc = R._decode(data)
    except UnicodeError as exc:
        raise _bad("not_csv", "The CSV text could not be decoded. Save it as UTF-8 and upload it again.") from exc
    delim = R._sniff_delimiter(text)
    csv.field_size_limit(MAX_FILE_BYTES + 1)
    recs: List[List[str]] = []
    try:
        for rec in csv.reader(io.StringIO(text, newline=""), delimiter=delim, strict=False):
            recs.append(rec)
            if len(recs) > _CSV_ROW_CAP + 1000:
                break
    except csv.Error as exc:
        raise _bad("corrupt", "The CSV file is malformed and cannot be read.") from exc
    if not recs or not any(c.strip() for c in recs[0]):
        raise _bad("header_missing", "Row 1 of the CSV file must hold the column names.")
    headers = [c for c in recs[0][:R.MAX_HEADER_COLS]]
    hcf = [_norm_header(h) for h in headers]
    dup = {h for h in hcf if h and hcf.count(h) > 1}
    if dup:
        raise _bad("header_duplicate", f'The column "{sorted(dup)[0]}" appears twice in row 1.')
    raw = [(i, [unguard(c) for c in rec]) for i, rec in enumerate(recs[1:], start=2)]
    rows = _read_cells(hcf, raw)
    names = {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}
    return CsvFile(headers, hcf, rows, enc, names[delim])


def detect_table(hcf: List[str], file_name: str) -> Optional[str]:
    """D-135: the table whose required columns are all present and which matches the most of its columns wins;
    a tie is Unrecognized (the file name only breaks a tie)."""
    have = set(h for h in hcf if h)
    best: List[Tuple[int, str]] = []
    for t in T.TABLES:
        if not all(c.header.casefold() in have for c in t.cols if c.required):
            continue
        score = sum(1 for c in t.cols if c.header.casefold() in have)
        best.append((score, t.key))
    if not best:
        return None
    top = max(s for s, _ in best)
    winners = [k for s, k in best if s == top]
    if len(winners) == 1:
        return winners[0]
    stem = re.sub(r"[^a-z]", "", file_name.rsplit(".", 1)[0].casefold())
    hint = [k for k in winners if re.sub(r"[^a-z]", "", T.BY_KEY[k].sheet.casefold()) in stem]
    return hint[0] if len(hint) == 1 else None


def missing_columns(t: T.Table, hcf: List[str]) -> List[str]:
    return [c.header for c in t.cols if c.required and c.header.casefold() not in hcf]

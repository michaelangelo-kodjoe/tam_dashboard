"""Adapter for Bloomberg Terminal BAMS Excel exports.

This module is deliberately narrow. It recognizes the Terminal BAMS workbook
shape and converts it in memory to the existing TAM Command Center BAMS import
schema. Existing BAMS template imports are not changed.

Recognized Terminal columns (row 1):
    Client, Ticker, Region, Metric, DC Location

Only configuration data is imported. BDP result/formula columns such as Current,
Last Update and interval highs/dates are ignored. Terminal Region (AMER/EMEA/APAC)
is also ignored because TAM's current "Region" field means East/West polarity.
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, Optional, Set

from .. import constants as C
from . import reader as R

_REQUIRED = {"client", "ticker", "metric", "dc_location"}
_HEADER_ALIASES = {
    "client": "client",
    "ticker": "ticker",
    "region": "terminal_region",
    "metric": "metric",
    "dc location": "dc_location",
}

# This mapping is intentionally explicit. Do not infer unknown BAMS families.
# These are the families present in the current Terminal export supplied for TAM.
_OBJECT_PREFIX = {
    "BMSES": "BA",  # appliance/server metric
    "BMSEN": "BA",  # appliance metric family in the supplied BAMS export
    "BMSER": "R",   # router metric
}

_TICKER_RE = re.compile(
    r"^(BMSE[A-Z])\s+(\d+)\s+(\d+)(?:\s+INDEX)?$",
    re.IGNORECASE,
)
_WS = re.compile(r"\s+")


def _check_terminal_zip(data: bytes) -> None:
    """Apply the normal import safety policy but accept Terminal workbookN.xml parts.

    Some Bloomberg Terminal-generated .xlsx files use xl/workbook2.xml rather than
    the conventional xl/workbook.xml. The shared importer intentionally requires the
    latter, so Terminal normalization needs this narrowly relaxed package check first.
    All macro, external-link, embedded-object, XML entity, encryption and ZIP-bomb
    protections remain enforced.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError, EOFError) as exc:
        raise R._bad("corrupt", "The workbook is damaged and cannot be read.") from exc
    try:
        infos = zf.infolist()
        if not infos:
            raise R._bad("corrupt", "The workbook is empty.")
        if len(infos) > R.MAX_ENTRIES:
            raise R._bad("zip_unsafe", f"The workbook has too many internal parts ({len(infos)}; limit {R.MAX_ENTRIES}).")

        total = 0
        seen = set()
        workbook_part = False
        content_types_seen = False
        budget = [R.MAX_TOTAL_UNCOMPRESSED]

        for info in infos:
            name = info.filename
            low = name.lower()
            if info.flag_bits & 0x1:
                raise R._bad("encrypted", "This workbook is password protected. Remove the password and upload it again.")
            if (name.startswith(("/", "\\")) or "\\" in name or re.match(r"^[A-Za-z]:", name)
                    or any(seg == ".." for seg in name.split("/")) or "\x00" in name):
                raise R._bad("zip_unsafe", "The workbook contains an unsafe internal path and was refused.")
            if low in seen:
                raise R._bad("zip_unsafe", "The workbook contains duplicate internal parts and was refused.")
            seen.add(low)
            if info.file_size > R.MAX_ENTRY:
                raise R._bad("zip_unsafe", "The workbook contains an oversized internal part and was refused.")
            if info.file_size > 0 and (info.compress_size == 0 or info.file_size / info.compress_size > R.MAX_RATIO):
                raise R._bad("zip_unsafe", "The workbook has an abnormal compression ratio and was refused.")
            total += info.file_size
            if total > R.MAX_TOTAL_UNCOMPRESSED:
                raise R._bad("zip_unsafe", "The workbook expands to an unsafe size and was refused.")

            if "vbaproject" in low or low.endswith(".vba"):
                raise R._bad("macros", "Workbooks with macros are not accepted. Save a macro-free .xlsx and upload it.")
            if low.startswith("xl/externallinks/"):
                raise R._bad("external_links", "Workbooks with links to other files are not accepted. Paste the values instead.")
            if (low.startswith(("xl/embeddings/", "xl/activex/", "xl/ole")) or "oleobject" in low
                    or (low.endswith(".bin") and not low.startswith("xl/printersettings/"))):
                raise R._bad("embedded_objects", "Workbooks with embedded objects are not accepted.")

            if re.fullmatch(r"xl/workbook\d*\.xml", low):
                workbook_part = True
            if low == "[content_types].xml":
                content_types_seen = True

        if not content_types_seen or not workbook_part:
            raise R._bad("not_xlsx", "This file is not a supported Bloomberg Terminal .xlsx workbook.")

        for info in infos:
            low = info.filename.lower()
            if not low.endswith(R._XML_EXT):
                continue
            body = R._read_bounded(zf, info, budget)
            lowered = body.lower()
            if any(p in lowered for p in R._DANGEROUS) or any(p in lowered for p in R._DANGEROUS_ENC):
                raise R._bad("xml_unsafe", "The workbook contains unsafe XML (DOCTYPE/ENTITY) and was refused.")
            if low == "[content_types].xml":
                if b"macroenabled" in lowered or b"vbaproject" in lowered:
                    raise R._bad("macros", "Workbooks with macros are not accepted. Save a macro-free .xlsx and upload it.")
                if b"spreadsheetml" not in lowered:
                    raise R._bad("not_xlsx", "This file is not a real .xlsx workbook. Open it in Excel and save it as .xlsx.")
            if low.endswith(".rels") and re.search(rb"targetmode\s*=\s*[\"']external[\"']", lowered):
                raise R._bad("external_links", "Workbooks with links to other files are not accepted. Paste the values instead.")
    finally:
        zf.close()


@dataclass(frozen=True)
class NormalizedTerminalUpload:
    data: bytes
    source_sheet: str
    rows_adapted: int
    ignored_terminal_regions: tuple[str, ...]


def _header_key(value: Any) -> str:
    if value is None:
        return ""
    return _WS.sub(" ", str(value)).strip().casefold()


def _cell_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = _WS.sub(" ", str(value)).strip()
    return text or None


def _map_headers(values: list[Any]) -> Dict[str, int]:
    mapping: Dict[str, int] = {}
    for idx, value in enumerate(values):
        fld = _HEADER_ALIASES.get(_header_key(value))
        if fld and fld not in mapping:
            mapping[fld] = idx
    return mapping


def _parse_ticker(raw: str, rownum: int) -> tuple[str, str]:
    text = _WS.sub(" ", raw).strip()
    match = _TICKER_RE.match(text)
    if not match:
        raise R._bad(
            "terminal_bams_ticker_invalid",
            f'Row {rownum}: Terminal BAMS ticker "{R._clip(text, 80)}" is not in the expected '
            '"BMSE? <metric-id> <managed-object-id>" format.',
            row=rownum,
            ticker=R._clip(text, 120),
        )
    family = match.group(1).upper()
    metric_id = match.group(2)
    object_id = match.group(3)
    object_prefix = _OBJECT_PREFIX.get(family)
    if object_prefix is None:
        raise R._bad(
            "terminal_bams_family_unmapped",
            f'Row {rownum}: BAMS ticker family "{family}" has no approved TAM managed-object mapping. '
            "Add an explicit mapping before importing it; the importer will not guess.",
            row=rownum,
            family=family,
        )
    return f"{object_prefix}{object_id}", f"{family} {metric_id} {object_id} Index"


def normalize_terminal_upload(data: bytes, filename: str) -> Optional[NormalizedTerminalUpload]:
    """Return a normalized workbook when *data* is a recognized Terminal BAMS export.

    Return None for ordinary TAM import templates so the existing reader handles them
    unchanged. Validation of the untrusted workbook is performed before openpyxl sees it.
    """
    # Let the existing hardened reader own oversized-file errors; importantly, do not
    # open an oversized untrusted workbook here.
    if len(data) > C.MAX_IMPORT_BYTES or not data:
        return None

    fmt = R.detect_format(data, filename)
    if fmt != "xlsx":
        return None

    # Bloomberg Terminal exports can use xl/workbook2.xml. Apply the same
    # security policy as the normal reader while allowing that package layout.
    _check_terminal_zip(data)

    openpyxl = R._load_openpyxl()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
    except Exception as exc:  # noqa: BLE001
        raise R._bad("corrupt", "The workbook is damaged and cannot be read.") from exc

    try:
        source_ws = None
        mapping: Dict[str, int] = {}
        for ws in wb.worksheets:
            try:
                header_cells = next(ws.iter_rows(min_row=1, max_row=1, max_col=100), ())
            except StopIteration:
                header_cells = ()
            candidate = _map_headers([getattr(c, "value", None) for c in header_cells])
            if _REQUIRED.issubset(candidate):
                source_ws = ws
                mapping = candidate
                break

        if source_ws is None:
            return None

        out_wb = openpyxl.Workbook()
        out_ws = out_wb.active
        out_ws.title = "Import"
        out_ws.append([
            "Account", "BPID", "Appliance", "Metric", "Ticker", "Region",
            "Location", "Environment", "Enabled", "Stale after (s)",
        ])

        adapted = 0
        ignored_regions: Set[str] = set()
        max_idx = max(mapping.values())

        for rownum, row in enumerate(
            source_ws.iter_rows(min_row=2, max_row=C.IMPORT_SCAN_ROWS, max_col=max_idx + 1),
            start=2,
        ):
            def val(field: str) -> Any:
                idx = mapping.get(field)
                return getattr(row[idx], "value", None) if idx is not None and idx < len(row) else None

            client = _cell_text(val("client"))
            ticker = _cell_text(val("ticker"))
            metric = _cell_text(val("metric"))
            location = _cell_text(val("dc_location"))
            terminal_region = _cell_text(val("terminal_region"))

            # Terminal export group/separator row, e.g. ticker cell contains
            # "EDGESTREAM PARTNERS LP (8)" while Client/Metric/Location are blank.
            if not client and ticker and not metric and not location:
                continue
            if not any((client, ticker, metric, location)):
                continue

            appliance = None
            canonical_ticker = ticker
            if ticker:
                appliance, canonical_ticker = _parse_ticker(ticker, rownum)

            if terminal_region:
                ignored_regions.add(terminal_region)

            # Preserve physical row numbers from the Terminal export so Preview errors
            # point back to the same Excel row. Blank rows between data are harmless.
            values = [
                client,               # Account
                None,                 # BPID
                appliance,            # Appliance / managed object
                metric,               # Metric
                canonical_ticker,     # Ticker (with Index yellow key)
                None,                 # Region = TAM polarity; do NOT copy AMER/EMEA/APAC
                location,             # Location
                None,                 # Environment intentionally unresolved
                "Yes",                # Enabled
                120,                  # Stale after seconds
            ]
            for col, value in enumerate(values, start=1):
                out_ws.cell(row=rownum, column=col, value=value)
            adapted += 1

        if adapted == 0:
            raise R._bad(
                "no_rows",
                "The Terminal BAMS workbook was recognized, but it contains no metric rows to import.",
            )

        bio = io.BytesIO()
        out_wb.save(bio)
        return NormalizedTerminalUpload(
            data=bio.getvalue(),
            source_sheet=source_ws.title,
            rows_adapted=adapted,
            ignored_terminal_regions=tuple(sorted(ignored_regions, key=str.casefold)),
        )
    finally:
        wb.close()

"""Rich note bodies: strict server-side HTML allowlist sanitiser (no schema change).

Storage: `notes.body` keeps either plain text (unchanged, legacy) or SANITISED HTML prefixed with RICH_MARKER.
The marker is an HTML comment, printable (survives CSV/XLSX export and restore) and is never shown to clients:
the API returns the HTML without it plus `body_format` ("plain" | "html") and `body_text` (plain projection).

Allowlist: p, br, strong/b, em/i, u, ul, ol, li, span (only a restricted font-size style or fs-* class, and a text colour from PALETTE).
Everything else is dropped (its text is kept; script/style/iframe/object/... content is dropped too). All
attributes are removed except the restricted span size. Links, images, forms and event handlers cannot survive
because their tags and attributes are not on the list; output is re-serialised from parsed tokens with
escaping, never passed through. Sanitising also runs when reading, so a rich body that reaches the database by a
restore or an import is still safe to render.
"""
from __future__ import annotations

import html
import re
from html.parser import HTMLParser
from typing import List, Optional, Tuple

RICH_MARKER = "<!--tam:rich-->"
MAX_STORED = 50000
FONT_MIN, FONT_MAX = 8, 48

_TAG_MAP = {"b": "strong", "i": "em", "div": "p"}
_ALLOWED = {"p", "br", "strong", "em", "u", "ul", "ol", "li", "span"}
_VOID = {"br"}
_DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "textarea",
                 "select", "option", "title", "head", "frameset", "applet", "xmp", "plaintext"}
_BLOCK = {"p", "li", "ul", "ol"}
_MAX_DEPTH = 20
_SIZE_CLASS = re.compile(r"^fs-(\d{1,2})$")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


PALETTE = {"#FA9A28": "Amber", "#E5484D": "Red", "#3FB950": "Green", "#4C9AFF": "Blue", "#B392F0": "Purple",
           "#8B949E": "Gray", "#F0F0F0": "White"}
_SIZE_VALUE = re.compile(r"^(\d{1,2}(?:\.\d{1,2})?)\s*(px|pt)$", re.IGNORECASE)


def _style(attrs: List[Tuple[str, Optional[str]]]) -> Tuple[Optional[int], Optional[str]]:
    """The only attributes that survive on a span: font size (`fs-<px>` class or `font-size`) and a palette colour.

    A style attribute is accepted only if EVERY declaration is a valid font-size or a palette colour; anything
    else (other properties, !important, rgb(), names, url(), expression(), malformed hex) rejects the whole style.
    """
    px: Optional[int] = None
    colour: Optional[str] = None
    for name, val in attrs:
        v = val or ""
        if name == "style":
            decls = [d.strip() for d in v.split(";") if d.strip()]
            ok = bool(decls)
            spx: Optional[int] = None
            scol: Optional[str] = None
            for d in decls:
                prop, sep, value = d.partition(":")
                prop, value = prop.strip().lower(), value.strip()
                if not sep:
                    ok = False
                elif prop == "font-size" and spx is None:
                    m = _SIZE_VALUE.match(value)
                    n = float(m.group(1)) * (4 / 3 if m.group(2).lower() == "pt" else 1) if m else -1
                    if FONT_MIN <= n <= FONT_MAX:
                        spx = int(round(n))
                    else:
                        ok = False
                elif prop == "color" and scol is None and value.upper() in PALETTE and re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
                    scol = value.upper()
                else:
                    ok = False
            if ok:
                px = spx if spx is not None else px
                colour = scol if scol is not None else colour
        elif name == "class":
            toks = v.split()
            if len(toks) == 1:
                m2 = _SIZE_CLASS.match(toks[0])
                if m2 and FONT_MIN <= int(m2.group(1)) <= FONT_MAX and px is None:
                    px = int(m2.group(1))
    return px, colour


class _Sanitiser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []
        self.stack: List[str] = []
        self.skip: Optional[str] = None
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        tag = tag.lower()
        if self.skip:
            if tag == self.skip:
                self.skip_depth += 1
            return
        if tag in _DROP_CONTENT:
            self.skip, self.skip_depth = tag, 1
            return
        tag = _TAG_MAP.get(tag, tag)
        if tag not in _ALLOWED:
            return
        if tag in _VOID:
            self.out.append("<br>")
            return
        if len(self.stack) >= _MAX_DEPTH:
            return
        if tag == "li" and not any(t in ("ul", "ol") for t in self.stack):
            return
        if tag == "span":
            px, colour = _style(attrs)
            if px is None and colour is None:
                return                                   # a span carrying nothing valid is dropped (text kept)
            parts = ([f"font-size: {px}px"] if px is not None else []) + ([f"color:{colour}"] if colour else [])
            self.out.append(f'<span style="{"; ".join(parts)}">')
        else:
            self.out.append(f"<{tag}>")
        self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag.lower() in _VOID:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip:
            if tag == self.skip:
                self.skip_depth -= 1
                if self.skip_depth == 0:
                    self.skip = None
            return
        tag = _TAG_MAP.get(tag, tag)
        if tag not in _ALLOWED or tag in _VOID or tag not in self.stack:
            return
        while self.stack:                                # close anything left open inside it, then the tag itself
            top = self.stack.pop()
            self.out.append(f"</{top}>")
            if top == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(html.escape(_CTRL.sub("", data), quote=False))

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_html(raw: str) -> str:
    p = _Sanitiser()
    p.feed(raw or "")
    p.close()
    return p.result()


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: List[str] = []
        self.lists: List[List[int]] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "br":
            self.parts.append("\n")
        elif tag in ("ul", "ol"):
            self.lists.append([0 if tag == "ol" else -1])
            self.parts.append("\n")
        elif tag == "li" and self.lists:
            cur = self.lists[-1]
            if cur[0] >= 0:
                cur[0] += 1
            self.parts.append("\n" + "  " * (len(self.lists) - 1) + (f"{cur[0]}. " if cur[0] >= 0 else "- "))
        elif tag == "p":
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("ul", "ol") and self.lists:
            self.lists.pop()
        if tag in ("p", "ul", "ol"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def html_to_text(clean_html: str) -> str:
    t = _Text()
    t.feed(clean_html)
    t.close()
    text = re.sub(r"\n{3,}", "\n\n", "".join(t.parts))
    return text.strip()


def is_rich(stored: Optional[str]) -> bool:
    return bool(stored) and stored.startswith(RICH_MARKER)


def to_storage(body: Optional[str], body_format: str) -> Optional[str]:
    """Value for notes.body. None / "" stay NULL-ish; an HTML body with no visible content is treated as empty."""
    if body is None:
        return None
    if body_format == "html":
        clean = sanitize_html(body.replace(RICH_MARKER, ""))
        if not html_to_text(clean):
            return None
        return RICH_MARKER + clean
    return body[len(RICH_MARKER):] if body.startswith(RICH_MARKER) else body    # plain text can never claim to be HTML


def public(stored: Optional[str]) -> Tuple[Optional[str], str, Optional[str]]:
    """(body for the client, "plain" | "html", plain-text projection). Plain text is returned untouched."""
    if not is_rich(stored):
        return stored, "plain", stored
    clean = sanitize_html(stored[len(RICH_MARKER):])
    return clean, "html", html_to_text(clean)


def search_text(stored: Optional[str]) -> str:
    return public(stored)[2] or ""

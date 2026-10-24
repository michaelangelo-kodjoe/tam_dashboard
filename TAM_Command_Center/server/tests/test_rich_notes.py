"""B-2: rich (formatted) notes. Strict server-side allowlist, plain notes unchanged, search/audit/round-trip intact."""
from __future__ import annotations

import pytest

from server import richtext as RT
from server.tests.test_portability import apply, export_bytes, ok_item, snap, up, wipe

GOOD = ('<p>Hello <strong>bold</strong> <b>b2</b> <em>it</em> <i>i2</i> <u>under</u> '
        '<span style="font-size: 18px">big</span></p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>')

XSS = [
    "<script>alert(1)</script>ok",
    "<img src=x onerror=alert(1)>ok",
    '<a href="javascript:alert(1)">click</a>',
    '<a href="https://evil.example" onclick="x()">link</a>',
    '<p onclick="alert(1)" style="background:url(javascript:alert(1))">x</p>',
    '<span style="font-size: 18px; background:url(javascript:alert(1))">x</span>',
    '<span style="font-size: 999px">x</span>',
    '<span class="evil fs-12" onmouseover="x()">x</span>',
    "<iframe src=//evil></iframe>ok",
    "<svg onload=alert(1)><script>alert(2)</script></svg>ok",
    "<style>body{display:none}</style>ok",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<!--<script>alert(1)</script>-->ok",
    '<form action="//evil"><input name=x></form>ok',
    "<object data=//evil></object><embed src=//evil>ok",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "<p>unclosed <strong>tags <em>everywhere",
    "<</p>script>alert(1)<</p>/script>",
]
BAD_FRAGMENTS = ("<script", "onerror", "onclick", "onload", "onmouseover", "javascript:", "<a ", "<a>", "<img", "<iframe",
                 "<style", "<svg", "<form", "<input", "<object", "<embed", "href", "src=")


def test_sanitiser_keeps_the_allowlist_and_normalises():
    out = RT.sanitize_html(GOOD)
    assert out == ('<p>Hello <strong>bold</strong> <strong>b2</strong> <em>it</em> <em>i2</em> <u>under</u> '
                   '<span style="font-size: 18px">big</span></p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>')
    assert RT.sanitize_html(out) == out                                            # idempotent
    assert RT.sanitize_html('<span class="fs-14">x</span>') == '<span style="font-size: 14px">x</span>'
    assert RT.sanitize_html('<span style="font-size: 12pt">x</span>') == '<span style="font-size: 16px">x</span>'
    assert RT.sanitize_html("a<br>b<br/>c") == "a<br>b<br>c"
    assert RT.sanitize_html("<div>x</div>") == "<p>x</p>"
    assert RT.sanitize_html("<li>orphan</li>") == "orphan"


@pytest.mark.parametrize("payload", XSS)
def test_xss_payloads_are_neutralised(payload):
    out = RT.sanitize_html(payload).lower()
    for frag in BAD_FRAGMENTS:
        assert frag not in out, (payload, out)
    import re
    assert set(re.findall(r"</?([a-z0-9]+)", out)) <= {"p", "br", "strong", "em", "u", "ul", "ol", "li", "span"}
    assert not re.search(r"<[^>]*\son\w+=", out)
    assert RT.sanitize_html(RT.sanitize_html(payload)) == RT.sanitize_html(payload)


def test_text_of_dropped_content_and_projection():
    assert RT.sanitize_html("<script>alert(1)</script>ok") == "ok"
    assert RT.sanitize_html("<a href='javascript:x'>click</a>") == "click"
    assert RT.html_to_text(RT.sanitize_html(GOOD)).splitlines()[0] == "Hello bold b2 it i2 under big"
    assert "- one" in RT.html_to_text(RT.sanitize_html(GOOD)) and "1. a" in RT.html_to_text(RT.sanitize_html(GOOD))


def mk(api, **kw):
    cid = api.mk_client("Rich Co")["id"]
    body = {"client_id": cid, "note_type": "Meeting Note", "subject": "S", **kw}
    return cid, api.ok("/api/note/save", body)["item"]


def test_plain_notes_unchanged_and_flagged_plain(build):
    api = build()
    cid, n = mk(api, body="<b>not html</b> & line1\nline2")
    assert n["body"] == "<b>not html</b> & line1\nline2" and n["body_format"] == "plain" and n["body_text"] == n["body"]
    assert api.sql("SELECT body FROM notes")[0]["body"] == "<b>not html</b> & line1\nline2"     # stored verbatim
    it = api.get(f"/api/client/{cid}/activity").json()["items"][0]
    assert it["body"] == n["body"] and it["body_format"] == "plain"
    # an explicit plain format is the same; a plain body can never claim to be rich
    n2 = api.ok("/api/note/save", {"id": n["id"], "expected_row_version": n["row_version"], "body_format": "plain",
                                   "body": RT.RICH_MARKER + "<script>x</script>"})["item"]
    assert n2["body_format"] == "plain" and n2["body"] == "<script>x</script>"


def test_rich_note_roundtrip_through_api(build):
    api = build()
    cid, n = mk(api, body=GOOD, body_format="html")
    assert n["body_format"] == "html" and n["body"] == RT.sanitize_html(GOOD) and n["body_text"].startswith("Hello bold")
    stored = api.sql("SELECT body FROM notes")[0]["body"]
    assert stored == RT.RICH_MARKER + n["body"]
    it = api.get(f"/api/client/{cid}/activity").json()["items"][0]
    assert (it["body"], it["body_format"], it["body_text"]) == (n["body"], "html", n["body_text"])
    # re-saving the same rich body is a no-op; editing it bumps the version and audits without the body text
    same = api.ok("/api/note/save", {"id": n["id"], "expected_row_version": n["row_version"], "body": GOOD, "body_format": "html"})
    assert same["side_effects"] == [{"type": "no_change"}]
    upd = api.ok("/api/note/save", {"id": n["id"], "expected_row_version": n["row_version"], "body": "<p>new <u>text</u></p>",
                                    "body_format": "html"})["item"]
    assert upd["row_version"] == n["row_version"] + 1 and upd["body"] == "<p>new <u>text</u></p>"
    aud = " ".join(str(a) for a in api.audit(object_type="note"))
    assert "new <u>" not in aud and "Hello" not in aud and "body_changed" in aud
    # html -> plain conversion works too
    back = api.ok("/api/note/save", {"id": n["id"], "expected_row_version": upd["row_version"], "body": "just text"})["item"]
    assert back["body_format"] == "plain" and back["body"] == "just text"


def test_rich_validation(build):
    api = build()
    cid = api.mk_client("V Co")["id"]
    base = {"client_id": cid, "note_type": "Call Note"}
    for empty in ("<p><br></p>", "<script>x</script>", "<b></b>"):
        api.err("/api/note/save", {**base, "body": empty, "body_format": "html"}, 422, "validation_error")
    api.err("/api/note/save", {**base, "subject": "s", "body_format": "html"}, 422, "validation_error")       # no body
    api.err("/api/note/save", {**base, "body": "x", "body_format": "markdown"}, 422, "validation_error")
    ok = api.ok("/api/note/save", {**base, "subject": "s", "body": "<p><br></p>", "body_format": "html"})["item"]
    assert ok["body"] is None and ok["body_format"] == "plain"                                          # empty rich body = no body
    # "&" grows to "&amp;" when cleaned: the limit applies to what is stored, so this must be refused, not a 500
    e = api.err("/api/note/save", {**base, "body": "&" * 20000, "body_format": "html"}, 422, "validation_error")
    assert "body" in e["fields"]


def test_xss_payloads_via_api_never_come_back_dangerous(build):
    api = build()
    cid = api.mk_client("X Co")["id"]
    for payload in XSS:
        n = api.ok("/api/note/save", {"client_id": cid, "note_type": "General Note", "subject": "x",
                                      "body": payload, "body_format": "html"})["item"]
        low = (n["body"] or "").lower()
        assert not any(f in low for f in BAD_FRAGMENTS), (payload, low)
    for it in api.get(f"/api/client/{cid}/activity", limit=100).json()["items"]:
        low = (it["body"] or "").lower()
        assert not any(f in low for f in BAD_FRAGMENTS)


def test_read_time_sanitising_protects_against_rows_that_bypassed_the_api(build):
    api = build()
    cid, n = mk(api, body="seed")
    api.exec("UPDATE notes SET body = ? WHERE id = ?", (RT.RICH_MARKER + '<p onclick="x()">hi</p><script>bad()</script>', n["id"]))
    it = api.get(f"/api/client/{cid}/activity").json()["items"][0]
    assert it["body"] == "<p>hi</p>" and it["body_format"] == "html"


def test_search_matches_visible_text_not_markup(build):
    api = build()
    cid, n = mk(api, subject="Plan", body="<p>Quarterly <strong>review</strong> A&amp;B <em>x < y</em></p>", body_format="html")
    mk2 = api.ok("/api/note/save", {"client_id": cid, "note_type": "General Note", "subject": "Other", "body": "plain strong text"})
    url = f"/api/client/{cid}/activity"
    ids = lambda q: [i["id"] for i in api.get(url, q=q).json()["items"]]  # noqa: E731
    assert ids("review") == [n["id"]] and ids("A&B") == [n["id"]] and ids("x < y") == [n["id"]]
    assert ids("strong") == [mk2["item"]["id"]]            # the tag name inside the rich note is not a hit
    assert ids("span") == [] and ids("tam:rich") == []


def test_export_restore_roundtrip_with_rich_note(build):
    api = build()
    cid, n = mk(api, body=GOOD, body_format="html")
    api.ok("/api/note/save", {"client_id": cid, "note_type": "General Note", "subject": "plain", "body": "a\nb"})
    before = snap(api)
    data = export_bytes(api)
    wipe(api)
    item = ok_item(up(api, data, "e.xlsx"))
    assert item["totals"]["invalid"] == 0
    apply(api, item)
    assert snap(api) == before
    it = {i["id"]: i for i in api.get(f"/api/client/{cid}/activity").json()["items"]}[n["id"]]
    assert it["body_format"] == "html" and it["body"] == RT.sanitize_html(GOOD)


# ------------------------------------------------------------------ B-4: text colour palette
PALETTE = {"#FA9A28", "#E5484D", "#3FB950", "#4C9AFF", "#B392F0", "#8B949E", "#F0F0F0"}


@pytest.mark.parametrize("hexv", sorted(PALETTE))
def test_palette_colours_survive_in_either_case(hexv):
    for v in (hexv, hexv.lower()):
        assert RT.sanitize_html(f'<span style="color:{v}">x</span>') == f'<span style="color:{hexv}">x</span>'
        assert RT.sanitize_html(f'<span style="COLOR : {v} ;">x</span>') == f'<span style="color:{hexv}">x</span>'


def test_size_and_colour_together_and_text_stays_colour_free():
    out = RT.sanitize_html('<p><span style="color:#fa9a28; font-size:20px">hot</span> plain</p>')
    assert out == '<p><span style="font-size: 20px; color:#FA9A28">hot</span> plain</p>'
    assert RT.sanitize_html(out) == out
    assert RT.html_to_text(out) == "hot plain"
    assert RT.sanitize_html('<span class="fs-14" style="color:#4C9AFF">x</span>') == '<span style="font-size: 14px; color:#4C9AFF">x</span>'


@pytest.mark.parametrize("style", [
    "color:#123456", "color:#FA9A2", "color:#FA9A288", "color:FA9A28", "color:#GGGGGG", "color:#fa9a28 !important",
    "color:red", "color:RED", "color:rgb(250,154,40)", "color:rgba(250,154,40,1)", "color:hsl(30,90%,55%)",
    "color:url(javascript:alert(1))", "color:expression(alert(1))", "color:var(--x)", "color:#FA9A28 #E5484D",
    "color:#FA9A28; background:red", "color:#FA9A28; position:fixed", "color:#FA9A28; background:url(x)",
    "color:#FA9A28;color:#E5484D", "background-color:#FA9A28", "color:#FA9A28 !important;", "colour:#FA9A28",
    "font-size:18px; color:#123456", "color:#FA9A28; font-size:999px", "\\63olor:#FA9A28", "color:#FA9A28/*x*/",
])
def test_colour_bypass_attempts_are_stripped(style):
    out = RT.sanitize_html(f'<span style="{style}">t</span>')
    assert out == "t", (style, out)


def test_colour_on_other_tags_and_attributes_is_ignored():
    for h in ('<p style="color:#FA9A28">x</p>', '<font color="#FA9A28">x</font>', '<strong style="color:#FA9A28">x</strong>',
              '<span color="#FA9A28">x</span>', '<span class="color:#FA9A28">x</span>'):
        out = RT.sanitize_html(h)
        assert "color" not in out and "style" not in out, (h, out)


def test_colour_note_roundtrip_api_and_export_restore(build):
    api = build()
    body = '<p><span style="color:#e5484d">red</span> and <span style="color:#3FB950; font-size:20px">green</span></p>'
    cid, n = mk(api, body=body, body_format="html")
    want = '<p><span style="color:#E5484D">red</span> and <span style="font-size: 20px; color:#3FB950">green</span></p>'
    assert n["body"] == want and n["body_text"] == "red and green"
    before = snap(api)
    data = export_bytes(api)
    wipe(api)
    item = ok_item(up(api, data, "e.xlsx"))
    apply(api, item)
    assert snap(api) == before
    it = api.get(f"/api/client/{cid}/activity").json()["items"][0]
    assert it["body"] == want and it["body_format"] == "html"

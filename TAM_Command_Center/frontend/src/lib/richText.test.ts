import { describe, expect, it } from 'vitest';
import { PALETTE, clampFont, colourAt, normaliseColours, selectionColour, htmlToText, isEmptyHtml, plainToHtml, sanitizeHtml } from './richText';

describe('palette colours', () => {
  it('keeps exactly the palette colours as span colour, normalised', () => {
    expect(sanitizeHtml('<span style="color:#fa9a28">a</span>')).toBe('<span style="color:#FA9A28">a</span>');
    expect(sanitizeHtml('<span style="color: rgb(229, 72, 77)">a</span>')).toBe('<span style="color:#E5484D">a</span>');
    for (const p of PALETTE) expect(sanitizeHtml(`<span style="color:${p.hex}">x</span>`)).toBe(`<span style="color:${p.hex}">x</span>`);
    expect(sanitizeHtml('<span style="color:#123456">a</span><span style="color:red">b</span>')).toBe('ab');
    expect(sanitizeHtml('<span style="color:#3FB950; background:url(x)">a</span>')).toBe('a'); // extra declaration drops the whole style
  });
  it('keeps size and colour on one span, size first', () => {
    expect(sanitizeHtml('<span style="font-size: 16px; color:#4C9AFF">a</span>')).toBe('<span style="font-size: 16px; color:#4C9AFF">a</span>');
  });
});

describe('rich text helpers', () => {
  it('turns plain text into escaped paragraphs', () => {
    expect(plainToHtml('a <b>\n\nc')).toBe('<p>a &lt;b&gt;</p><p><br></p><p>c</p>');
  });
  it('keeps the allowed formatting', () => {
    const h = '<p>Hi <strong>bold</strong> <em>it</em> <u>u</u></p><ul><li>one</li></ul><ol><li>two</li></ol><p><span style="font-size: 16px">big</span></p>';
    expect(sanitizeHtml(h)).toBe(h);
  });
  it('removes scripts, handlers, links, images and other attributes', () => {
    expect(sanitizeHtml('<p onclick="x()">a<script>alert(1)</script><a href="javascript:x">link</a><img src=x onerror=y>z</p>')).toBe('<p>alinkz</p>');
    expect(sanitizeHtml('<div class="c" style="color:red">t</div>')).toBe('t');
    expect(sanitizeHtml('<span style="color:red">t</span><span style="font-size: 99px">u</span><span style="font-size: 12px; color: red">v</span>')).toBe('tuv'); // a style with any non-palette declaration is dropped whole, like the server
    expect(sanitizeHtml('<iframe src="x">hidden</iframe><b>ok</b>')).toBe('<b>ok</b>');
  });
  it('detects empty editor output', () => {
    expect(isEmptyHtml('')).toBe(true);
    expect(isEmptyHtml('<p><br></p>')).toBe(true);
    expect(isEmptyHtml('<p>​</p>')).toBe(true);
    expect(isEmptyHtml('<ul><li>x</li></ul>')).toBe(false);
  });
  it('projects to plain text with list markers', () => {
    expect(htmlToText('<p>Attendees: Priya</p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>')).toBe('Attendees: Priya\n- one\n- two\n1. a\n2. b');
  });
  it('clamps font sizes to 11..20', () => {
    expect([8, 11, 13.4, 25].map(clampFont)).toEqual([11, 11, 13, 20]);
  });
});

describe('normaliseColours (editor DOM)', () => {
  const root = (html: string) => { const r = document.createElement('div'); r.innerHTML = html; document.body.appendChild(r); return r; };
  it('turns font tags and rgb spans into palette spans', () => {
    const r = root('<font color="#e5484d">a</font><span style="color: rgb(63, 185, 80)">b</span>');
    normaliseColours(r);
    expect(sanitizeHtml(r.innerHTML)).toBe('<span style="color:#E5484D">a</span><span style="color:#3FB950">b</span>');
  });
  it('leaves font tags that carry a size to the size handler', () => {
    const r = root('<font size="7" color="#e5484d">a</font>');
    normaliseColours(r);
    expect(r.querySelector('font')).not.toBeNull();
  });
  it('default colour (marker or the editor colour) on plain text just unwraps', () => {
    const r = root('<p>a<span style="color:#000001">b</span>c</p>');
    normaliseColours(r);
    expect(r.innerHTML).toBe('<p>abc</p>');
  });
  it('default colour inside a palette span splits it so the text is really uncoloured', () => {
    const r = root('<p><span style="color:#E5484D">one <span style="color:#000001">two</span> three</span></p>');
    normaliseColours(r);
    expect(sanitizeHtml(r.innerHTML)).toBe('<p><span style="color:#E5484D">one </span>two<span style="color:#E5484D"> three</span></p>');
  });
  it('a new palette colour inside an older one stays nested and wins; switching several times keeps the last', () => {
    const r = root('<span style="color:#E5484D">a<span style="color:#3FB950">b<span style="color:#4C9AFF">c</span></span></span>');
    normaliseColours(r);
    expect(colourAt(r.querySelector('span span span')!.firstChild, 0, r)).toBe('#4C9AFF');
    expect(colourAt(r.querySelector('span span')!.firstChild, 0, r)).toBe('#3FB950');
  });
  it('removes empty spans and keeps bold wrappers when splitting', () => {
    const r = root('<span style="color:#E5484D"><b>x<span style="color:#000001">y</span>z</b></span><span></span>');
    normaliseColours(r);
    expect(sanitizeHtml(r.innerHTML)).toBe('<span style="color:#E5484D"><b>x</b></span><b>y</b><span style="color:#E5484D"><b>z</b></span>');
  });
});

describe('selectionColour', () => {
  it('reads the first selected character even when the range edge sits in the previous node', () => {
    const r = document.createElement('div');
    r.innerHTML = '<p>one <span style="color:#4C9AFF">two</span> <span style="color:#3FB950">three</span></p>';
    const p = r.firstChild!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 4); // end of "one " (plain)
    range.setEnd(p.childNodes[1].firstChild!, 3);
    expect(selectionColour(range, r)).toBe('#4C9AFF');
    const all = document.createRange(); all.selectNodeContents(r);
    expect(selectionColour(all, r)).toBeNull(); // starts with plain text
  });
});

describe('colourAt', () => {
  it('reads the colour of the character before an element-level caret, and default when none', () => {
    const r = document.createElement('div');
    r.innerHTML = '<p>one <span style="color:#E5484D">two</span></p><p>plain</p>';
    expect(colourAt(r.firstChild, 2, r)).toBe('#E5484D'); // caret after the span
    expect(colourAt(r.firstChild, 1, r)).toBeNull(); // caret after "one "
    expect(colourAt(r.lastChild!.firstChild, 2, r)).toBeNull();
    expect(colourAt(null, 0, r)).toBeNull();
  });
});

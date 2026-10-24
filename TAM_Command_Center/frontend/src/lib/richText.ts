// Formatted (rich) note bodies: contract section 17.1. Stored as sanitised HTML (body_format "html"); old notes stay plain.
// The server sanitises on write and read; sanitizeHtml() below is defence in depth before anything reaches innerHTML.

export const FONT_MIN = 11;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 13;
export const clampFont = (n: number): number => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain text to editor HTML: one paragraph per line (blank lines keep their height). */
export function plainToHtml(text: string): string {
  return text.split('\n').map((l) => `<p>${l ? esc(l) : '<br>'}</p>`).join('');
}

/** Fixed text colour palette; the server sanitiser accepts exactly these as `<span style="color:#RRGGBB">`. */
export const PALETTE = [
  { name: 'Amber', hex: '#FA9A28' }, { name: 'Red', hex: '#E5484D' }, { name: 'Green', hex: '#3FB950' }, { name: 'Blue', hex: '#4C9AFF' },
  { name: 'Purple', hex: '#B392F0' }, { name: 'Gray', hex: '#8B949E' }, { name: 'White', hex: '#F0F0F0' },
] as const;
/** execCommand foreColor marker meaning "back to the default colour" (never stored). */
export const DEFAULT_MARK = '#000001';
/** The palette colour for any spelling of its hex (#fa9a28, rgb(250, 154, 40)), else null. */
export function paletteHex(v: string): string | null {
  const t = v.trim().toLowerCase();
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(t);
  const hex = rgb ? `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}` : t;
  return PALETTE.find((p) => p.hex.toLowerCase() === hex)?.hex ?? null;
}

const ALLOWED = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'SPAN']);
const DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE', 'LINK', 'META']);
const FONT_RE = /^\s*font-size\s*:\s*(\d{1,2})(?:\.\d+)?\s*(px|pt)\s*;?\s*$/i;

/** Allowlist sanitiser mirroring the server: p br strong/b em/i u ul ol li and span with only a font size (8..48). */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = doc.createElement('div');
  const walk = (src: Node, dst: Node) => {
    src.childNodes.forEach((n) => {
      if (n.nodeType === 3) { dst.appendChild(doc.createTextNode(n.textContent ?? '')); return; }
      if (n.nodeType !== 1) return;
      const el = n as Element;
      const tag = el.tagName.toUpperCase();
      if (DROP_WITH_CONTENT.has(tag)) return;
      if (!ALLOWED.has(tag)) { walk(el, dst); return; }
      if (tag === 'SPAN') {
        // Same rule as the server: every declaration must be a valid font-size or a palette colour, otherwise the span unwraps.
        // Stored form: "font-size: Npx; color:#RRGGBB" (size first, colour upper-case).
        let size: string | null = null; let color: string | null = null; let ok = true;
        for (const d of (el.getAttribute('style') ?? '').split(';').filter((x) => x.trim())) {
          const [k, ...rest] = d.split(':'); const v = rest.join(':');
          const key = k.trim().toLowerCase();
          if (key === 'font-size' && size === null) { const m = FONT_RE.exec(`font-size:${v}`); if (m && Number(m[1]) >= 8 && Number(m[1]) <= 48) size = `${Number(m[1])}${m[2].toLowerCase()}`; else ok = false; }
          else if (key === 'color' && color === null) { color = paletteHex(v); if (!color) ok = false; }
          else ok = false;
        }
        if (!ok || (!size && !color)) { walk(el, dst); return; }
        const s1 = doc.createElement('span');
        s1.setAttribute('style', [size ? `font-size: ${size}` : '', color ? `color:${color}` : ''].filter(Boolean).join('; '));
        walk(el, s1); dst.appendChild(s1);
        return;
      }
      const c = doc.createElement(tag.toLowerCase());
      if (tag !== 'BR') walk(el, c);
      dst.appendChild(c);
    });
  };
  walk(doc.body, out);
  return out.innerHTML;
}

/** True when the HTML has no visible text and no list/line structure worth saving. */
export function isEmptyHtml(html: string): boolean {
  if (!html) return true;
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return (d.body.textContent ?? '').replace(/​/g, '').trim() === '';
}

/** Plain-text projection (list items as "- " / "1. "), used for previews and the mock backend. */
export function htmlToText(html: string): string {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const lines: string[] = [];
  const inline = (n: Node): string => (n.nodeType === 3 ? n.textContent ?? '' : n.nodeName === 'BR' ? '\n' : [...n.childNodes].map(inline).join(''));
  d.body.childNodes.forEach((n) => {
    if (n.nodeName === 'UL' || n.nodeName === 'OL') {
      let i = 0;
      n.childNodes.forEach((li) => { if (li.nodeName === 'LI') lines.push(`${n.nodeName === 'OL' ? `${++i}. ` : '- '}${inline(li).trim()}`); });
    } else lines.push(inline(n).trim());
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- editor colour normalisation (live DOM)

const isEmptyEl = (e: Element) => !e.textContent && !e.querySelector('br,img');

/** Split the colour span `a` around `s` (a descendant): text before and after stay coloured, `s` ends up outside `a`. */
function splitOut(a: Element, s: Element): void {
  const doc = a.ownerDocument;
  const pre = doc.createRange(); pre.setStartBefore(a.firstChild!); pre.setEndBefore(s);
  const post = doc.createRange(); post.setStartAfter(s); post.setEndAfter(a.lastChild!);
  const preEl = a.cloneNode(false) as Element; preEl.append(pre.extractContents());
  const postEl = a.cloneNode(false) as Element; postEl.append(post.extractContents());
  a.before(preEl); a.after(postEl);
  // `a` now holds only the path down to `s`: replace it by its content, then unwrap `s` itself by the caller
  a.replaceWith(...a.childNodes);
}

/**
 * Bring editor markup to what the server accepts: `<font color>` and browser colour spans become palette spans;
 * any other colour (the editor's own default colour, the DEFAULT_MARK marker) means "default text colour" and is
 * removed, splitting enclosing palette spans so the text really is uncoloured. Font tags carrying a size are left to
 * the size handler.
 */
export function normaliseColours(root: Element): void {
  const doc = root.ownerDocument;
  root.querySelectorAll('font').forEach((f) => {
    if (f.hasAttribute('size')) return;
    const span = doc.createElement('span');
    const c = f.getAttribute('color');
    if (c) span.style.color = c;
    span.append(...f.childNodes);
    f.replaceWith(span);
  });
  const spans = [...root.querySelectorAll<HTMLElement>('span')].reverse(); // descendants first
  for (const s of spans) {
    if (!s.isConnected || !s.style.color) continue;
    const hex = paletteHex(s.style.color);
    if (hex) { s.style.color = hex; continue; }
    // default colour: split any enclosing palette span out of the way, then drop this span
    const holder = (): Element | null => {
      for (let e = s.parentElement; e && e !== root; e = e.parentElement) if ((e as HTMLElement).style?.color && paletteHex((e as HTMLElement).style.color)) return e;
      return null;
    };
    for (let h = holder(), n = 0; h && n < 20; h = holder(), n++) splitOut(h, s);
    if (s.style.fontSize) s.style.removeProperty('color'); // keep a size the span carries; only its colour goes
    else s.replaceWith(...s.childNodes);
  }
  root.querySelectorAll('span').forEach((s) => { if (isEmptyEl(s)) s.remove(); });
}

/**
 * Palette colour in effect at a caret position (nearest ancestor span with a colour; null = default). A caret at
 * element level reads the node just before it, like Word reads the previous character.
 */
export function colourAt(node: Node | null, offset: number, root: Element): string | null {
  let at: Node | null = node;
  if (at && at.nodeType === 1) {
    let c: Node | null = at.childNodes[offset - 1] ?? at.childNodes[offset] ?? null;
    while (c && c.lastChild) c = c.lastChild;
    at = c ?? at;
  }
  const start: Element | null = at ? (at.nodeType === 3 ? at.parentElement : (at as Element)) : null;
  for (let e = start; e && e !== root; e = e.parentElement) {
    const c = (e as HTMLElement).style?.color;
    if (c) return paletteHex(c);
  }
  return null;
}

/** The text node holding the first selected character (a selection's edge can sit in the neighbouring node), else the start container. */
export function firstSelectedNode(range: Range, root: Element): { node: Node; offset: number } {
  if (!range.collapsed) {
    const walker = root.ownerDocument.createTreeWalker(range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.textContent?.length ?? 0;
      if (!len || !range.intersectsNode(n)) continue;
      if (n === range.startContainer && range.startOffset >= len) continue;
      if (n === range.endContainer && range.endOffset === 0) continue;
      return { node: n, offset: 0 };
    }
  }
  return { node: range.startContainer, offset: range.startOffset };
}

/** Colour of the first selected character. */
export function selectionColour(range: Range, root: Element): string | null {
  const { node, offset } = firstSelectedNode(range, root);
  return colourAt(node, offset, root);
}

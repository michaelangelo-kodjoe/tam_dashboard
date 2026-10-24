import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Italic, List, ListOrdered, RemoveFormatting, Underline } from 'lucide-react';
import { FONT_DEFAULT, PALETTE, clampFont, firstSelectedNode, isEmptyHtml, normaliseColours, sanitizeHtml, selectionColour } from '../../lib/richText';
import { cx } from '../../lib/cx';

type Cmd = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList';
const exec = (c: string, v?: string) => { if (typeof document.execCommand === 'function') document.execCommand(c, false, v); };

/** Toolbar button. Defined at module level so the toolbar is never remounted (keyboard focus stays on it). */
function Btn({ label, pressed, onClick, children, tabIndex, popup, expanded, btnRef }: {
  label: string; pressed?: boolean; onClick: () => void; children: ReactNode; tabIndex: number; popup?: boolean; expanded?: boolean; btnRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button type="button" data-tb="" ref={btnRef} tabIndex={tabIndex} aria-label={label} title={label} aria-pressed={pressed} aria-haspopup={popup ? 'true' : undefined} aria-expanded={popup ? !!expanded : undefined}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>
  );
}

/**
 * Small rich-text editor for note bodies (mockup 04): font size down/up, bold, italic, underline, text colour
 * (fixed palette), bullet and numbered lists, clear formatting. Uncontrolled after mount (`initialHtml`); every
 * edit reports the HTML (empty string when nothing is left). Ctrl+B/I/U work natively; the toolbar is a roving
 * tabindex toolbar (arrows, Home, End; Enter/Space activate) and keeps the editor selection across activations.
 */
export function RichTextEditor({ id, initialHtml, onChange, invalid, describedBy, label = 'Body', minHeight = 140 }: {
  id?: string;
  /** trusted or sanitised HTML; sanitised again here */
  initialHtml: string;
  onChange: (html: string) => void;
  invalid?: boolean;
  describedBy?: string;
  label?: string;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [state, setState] = useState<Record<Cmd, boolean>>({ bold: false, italic: false, underline: false, insertUnorderedList: false, insertOrderedList: false });
  const [size, setSize] = useState(FONT_DEFAULT);
  const [rove, setRove] = useState(0);
  const [palette, setPalette] = useState(false);
  const [cur, setCur] = useState<string | null>(null); // palette colour at the caret/selection (null = default)
  /** formatting chosen at a bare caret, applied to the next typed text like Word: colour (hex, null = default) and/or size (px) */
  const pendRef = useRef<{ color?: string | null; size?: number } | null>(null);
  const colorBtn = useRef<HTMLButtonElement | null>(null);
  const swatches = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { if (ref.current) ref.current.innerHTML = sanitizeHtml(initialHtml); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sanitise on the way out: browsers store colours in functional notation; the server only accepts the palette hex form.
  const emit = () => { const h = sanitizeHtml(ref.current?.innerHTML ?? ''); onChange(isEmptyHtml(h) ? '' : h); };
  const refresh = () => {
    const root = ref.current;
    const sel = window.getSelection();
    if (!root || !sel || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
    if (sel.rangeCount) saved.current = sel.getRangeAt(0).cloneRange();
    // Word shows the colour of the character before the caret; a pending colour (chosen at a bare caret) wins until text is typed
    if (pendRef.current?.color === undefined) setCur(selectionColour(sel.getRangeAt(0), root));
    if (typeof document.queryCommandState !== 'function') return;
    const q = (c: Cmd) => { try { return document.queryCommandState(c); } catch { return false; } };
    setState({ bold: q('bold'), italic: q('italic'), underline: q('underline'), insertUnorderedList: q('insertUnorderedList'), insertOrderedList: q('insertOrderedList') });
    if (pendRef.current?.size == null) {
      const f = firstSelectedNode(sel.getRangeAt(0), root).node;
      const n = f.nodeType === 3 ? f.parentElement : (f as Element);
      if (n) setSize(clampFont(parseFloat(getComputedStyle(n).fontSize) || FONT_DEFAULT));
    }
  };
  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    return () => document.removeEventListener('selectionchange', refresh);
  }, []);

  /** Put focus and the last editor selection back (a keyboard-activated button holds focus, not the editor). */
  const restore = (): boolean => {
    const root = ref.current;
    if (!root) return false;
    root.focus();
    const sel = window.getSelection();
    if (saved.current && sel && root.contains(saved.current.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(saved.current); }
    return !!sel && sel.rangeCount > 0 && !sel.isCollapsed && root.contains(sel.anchorNode);
  };
  /** Run an editor command; when a toolbar button holds focus (keyboard use) it gets focus back afterwards. */
  const withEditor = (fn: () => void) => {
    const a = document.activeElement as HTMLElement | null;
    const keep = a && bar.current?.contains(a) && !a.closest('.rte-pal') ? a : null;
    fn();
    if (keep && document.contains(keep)) keep.focus();
  };
  const run = (c: Cmd) => withEditor(() => { restore(); exec(c); emit(); refresh(); });

  const changeSize = (delta: number) => withEditor(() => {
    const root = ref.current;
    if (!root) return;
    const next = clampFont(size + delta); // `size` is the readout: pending size, else the size at the caret or selection
    if (!restore()) { // bare caret: the new size applies to what is typed next; nothing else changes
      pendRef.current = { ...pendRef.current, size: next };
      setSize(next);
      return;
    }
    exec('styleWithCSS', 'false');
    exec('fontSize', '7');
    const spans: HTMLElement[] = [];
    root.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${next}px`;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
      spans.push(span);
    });
    const after = window.getSelection();
    if (spans.length && after) { // keep the resized text selected so further steps and formats apply to it
      const r = document.createRange();
      r.setStartBefore(spans[0]); r.setEndAfter(spans[spans.length - 1]);
      after.removeAllRanges(); after.addRange(r);
    }
    if (after && after.rangeCount) saved.current = after.getRangeAt(0).cloneRange();
    pendRef.current = null;
    setSize(next);
    emit();
  });
  const applyColor = (hex: string | null, viaKey: boolean) => {
    const root = ref.current;
    if (!root) return;
    const hadSelection = restore();
    if (hadSelection) { // only the selected text changes
      exec('styleWithCSS', 'true');
      exec('foreColor', hex ?? getComputedStyle(root).color);
      normaliseColours(root);
      const live = window.getSelection();
      if (live && live.rangeCount) saved.current = live.getRangeAt(0).cloneRange();
      pendRef.current = null;
    } else pendRef.current = { ...pendRef.current, color: hex }; // bare caret: colour what is typed next, nothing else
    setCur(hex);
    setPalette(false);
    emit();
    if (viaKey) colorBtn.current?.focus();
    else if (hadSelection) { root.focus(); refresh(); } // keep the live selection: the saved range predates the DOM edit
    else restore();
  };
  /** Typed text with a pending colour goes into its own span (or plain text for Default); the caret stays after it. */
  const onBeforeInput = (e: InputEvent) => {
    const root = ref.current;
    const p = pendRef.current;
    if (!root || !p) return;
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') return; // the colour waits for the next character
    const sel = window.getSelection();
    if (e.inputType !== 'insertText' || !e.data || e.data.includes('\n') || e.isComposing || !sel || !sel.rangeCount) { pendRef.current = null; return; }
    e.preventDefault();
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const span = document.createElement('span');
    if (p.color !== undefined) span.style.color = p.color ?? getComputedStyle(root).color;
    if (p.size != null) span.style.fontSize = `${p.size}px`;
    const text = document.createTextNode(e.data);
    span.appendChild(text);
    r.insertNode(span);
    pendRef.current = null;
    normaliseColours(root); // Default unwraps the span and splits any enclosing palette span
    const caret = document.createRange();
    caret.setStart(text, text.length); caret.collapse(true);
    sel.removeAllRanges(); sel.addRange(caret);
    emit();
    refresh();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  });
  const endPending = () => { if (pendRef.current) { pendRef.current = null; setTimeout(refresh, 0); } };
  const clear = () => withEditor(() => {
    const root = ref.current;
    if (!root) return;
    if (!restore()) { // bare caret: what is typed next is plain (default colour and size)
      pendRef.current = { color: null, size: FONT_DEFAULT };
      setCur(null); setSize(FONT_DEFAULT);
      return;
    }
    exec('removeFormat');
    root.querySelectorAll('span[style]').forEach((s) => { if (window.getSelection()?.containsNode(s, true)) s.replaceWith(...s.childNodes); });
    const live = window.getSelection();
    if (live && live.rangeCount) saved.current = live.getRangeAt(0).cloneRange();
    setSize(FONT_DEFAULT);
    emit();
  });

  const items = () => [...(bar.current?.querySelectorAll<HTMLButtonElement>('button[data-tb]') ?? [])];
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.rte-pal')) return;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const n = e.key === 'ArrowRight' ? (i + 1) % list.length : e.key === 'ArrowLeft' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    setRove(n);
    list[n].focus();
  };
  const onPalKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = swatches.current.filter(Boolean) as HTMLButtonElement[];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPalette(false); colorBtn.current?.focus(); return; }
    const n = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % list.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
    if (n >= 0) { e.preventDefault(); list[n].focus(); }
  };
  const tab = (k: number) => (rove === k ? 0 : -1);
  const openPalette = () => {
    setPalette((o) => !o);
    setTimeout(() => swatches.current[0]?.focus(), 0);
  };

  return (
    <div className={cx('rte', invalid && 'is-invalid')}>
      <div className="rte-tb" role="toolbar" aria-label={`${label} formatting`} ref={bar} onKeyDown={onBarKey}>
        <Btn tabIndex={tab(0)} label="Smaller text" onClick={() => changeSize(-1)}>A−</Btn>
        <span className="fs num" aria-hidden="true">{size} px</span>
        <Btn tabIndex={tab(1)} label="Larger text" onClick={() => changeSize(1)}>A+</Btn>
        <span className="sepv" aria-hidden="true" />
        <Btn tabIndex={tab(2)} label="Bold (Ctrl+B)" pressed={state.bold} onClick={() => run('bold')}><Bold size={14} strokeWidth={2} aria-hidden="true" /></Btn>
        <Btn tabIndex={tab(3)} label="Italic (Ctrl+I)" pressed={state.italic} onClick={() => run('italic')}><Italic size={14} strokeWidth={2} aria-hidden="true" /></Btn>
        <Btn tabIndex={tab(4)} label="Underline (Ctrl+U)" pressed={state.underline} onClick={() => run('underline')}><Underline size={14} strokeWidth={2} aria-hidden="true" /></Btn>
        <span className="rte-palwrap">
          <Btn tabIndex={tab(5)} label={`Text colour: ${(PALETTE.find((c) => c.hex === cur)?.name ?? 'Default')}`} popup expanded={palette} btnRef={(el) => { colorBtn.current = el; }} onClick={openPalette}><span className="rte-a" aria-hidden="true">A<i className="rte-a-bar" style={cur ? { background: cur } : undefined} data-colour={cur ?? 'default'} /></span></Btn>
          {palette && (
            <div className="rte-pal" role="group" aria-label="Text colour" onKeyDown={onPalKey}>
              {PALETTE.map((c, k) => (
                <button key={c.hex} type="button" ref={(el) => { swatches.current[k] = el; }} className="rte-sw" style={{ background: c.hex }} aria-label={c.name} title={c.name}
                  onMouseDown={(e) => e.preventDefault()} onClick={(e) => applyColor(c.hex, e.detail === 0)} />
              ))}
              <button type="button" ref={(el) => { swatches.current[PALETTE.length] = el; }} className="rte-sw rte-sw--default" aria-label="Default" title="Default colour"
                onMouseDown={(e) => e.preventDefault()} onClick={(e) => applyColor(null, e.detail === 0)}>Default</button>
            </div>
          )}
        </span>
        <span className="sepv" aria-hidden="true" />
        <Btn tabIndex={tab(6)} label="Bulleted list" pressed={state.insertUnorderedList} onClick={() => run('insertUnorderedList')}><List size={14} strokeWidth={1.5} aria-hidden="true" /></Btn>
        <Btn tabIndex={tab(7)} label="Numbered list" pressed={state.insertOrderedList} onClick={() => run('insertOrderedList')}><ListOrdered size={14} strokeWidth={1.5} aria-hidden="true" /></Btn>
        <span className="sepv" aria-hidden="true" />
        <Btn tabIndex={tab(8)} label="Clear formatting" onClick={clear}><RemoveFormatting size={14} strokeWidth={1.5} aria-hidden="true" />Clear</Btn>
      </div>
      <div
        id={id} ref={ref} className="rte-body rendered" role="textbox" aria-multiline="true" aria-label={label} contentEditable suppressContentEditableWarning
        aria-invalid={invalid || undefined} aria-describedby={describedBy} style={{ minHeight }} spellCheck
        onInput={emit} onBlur={emit} onMouseDown={endPending}
        onKeyDown={(e) => { if (/^(Arrow\w+|Home|End|PageUp|PageDown|Backspace|Delete)$/.test(e.key)) endPending(); }}
        onPaste={(e) => { e.preventDefault(); exec('insertText', e.clipboardData.getData('text/plain')); }}
      />
    </div>
  );
}

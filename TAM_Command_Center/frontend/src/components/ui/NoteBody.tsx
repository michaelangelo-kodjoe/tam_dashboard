import { createElement, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { paletteHex, sanitizeHtml } from '../../lib/richText';
import type { Note } from '../../types';
import { RichText } from './Feedback';

/** True when the note body needs a Show more control. */
export function isLongNote(n: Pick<Note, 'body' | 'body_format' | 'body_text'>): boolean {
  const t = n.body_format === 'html' ? n.body_text ?? '' : n.body ?? '';
  return t.length > 360 || t.split('\n').length > 6;
}

/**
 * Plain notes render as text (exactly as before). Formatted notes render their sanitised HTML; a collapsed long one
 * shows a 2-line plain-text preview instead (formatting stripped).
 */
export function NoteBody({ note, expanded, long }: { note: Note; expanded: boolean; long: boolean }) {
  if (!note.body) return null;
  if (note.body_format !== 'html') return <RichText text={note.body} className={cx('note__body', long && !expanded && 'is-clamped')} />;
  if (long && !expanded) return <div className="richtext note__body note__preview">{note.body_text ?? ''}</div>;
  return <div className="rendered note__body note__html">{htmlToReact(note.body)}</div>;
}

/** Sanitised HTML to React elements (no innerHTML): only the allowlisted tags and the font-size span survive. */
export function htmlToReact(html: string): ReactNode[] {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, 'text/html');
  const conv = (n: Node, key: string): ReactNode => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1) return null;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return createElement('br', { key });
    const props: { key: string; style?: { fontSize?: string; color?: string } } = { key };
    if (tag === 'span' && (el.style.fontSize || el.style.color)) {
      const color = paletteHex(el.style.color);
      props.style = { ...(el.style.fontSize ? { fontSize: el.style.fontSize } : {}), ...(color ? { color } : {}) };
    }
    return createElement(tag, props, ...[...el.childNodes].map((c, i) => conv(c, `${key}.${i}`)));
  };
  return [...doc.body.childNodes].map((c, i) => conv(c, String(i)));
}

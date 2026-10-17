import { Fragment } from 'react';
import { parseTerminalText } from '../../lib/terminalLinks';

/**
 * Display-only text with Bloomberg Terminal links for every {command}. Plain React nodes (no HTML injection).
 * Never use it inside an <a>, input, textarea or contenteditable: those keep the raw text.
 * Clicks and Enter/Space stay inside the link so clickable rows and listboxes do not also act (navigation is not prevented).
 */
export function TerminalLinkText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <>
      {parseTerminalText(text).map((p, i) =>
        p.type === 'text' ? (
          <Fragment key={i}>{p.value}</Fragment>
        ) : (
          <a
            key={i}
            className="tlink"
            href={p.href}
            aria-label={`Open ${p.label} in Bloomberg Terminal`}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {p.label}
          </a>
        ),
      )}
    </>
  );
}

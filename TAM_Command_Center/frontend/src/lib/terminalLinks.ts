// Bloomberg Terminal screen links: text in { } becomes bbg://screens/<command>. Pure parser, no HTML.
export type TextPart =
  | { type: 'text'; value: string }
  | { type: 'terminal'; label: string; command: string; href: string };

const TOKEN = /\{([^{}\n]*)\}/g;
const GO = /\s*<GO>\s*$/i;

export function terminalHref(command: string): string {
  return `bbg://screens/${encodeURIComponent(command)}`;
}

/** The command inside braces: trailing <GO> stripped, whitespace trimmed. Empty string = not a command. */
export function commandOf(inner: string): string {
  return inner.trim().replace(GO, '').trim();
}

export function parseTerminalText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const command = commandOf(m[1]);
    if (!command) continue; // {} and { <GO> } stay ordinary text
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: 'text', value: text.slice(last, at) });
    parts.push({ type: 'terminal', label: m[0], command, href: terminalHref(command) });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
  return parts;
}

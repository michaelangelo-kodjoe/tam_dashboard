// Action items on a saved note -> optional new tasks (one prompt per line).
export const TASK_TITLE_MAX = 500;

/** Non-empty lines; leading bullets ("-", "*", "•", "1.", "1)", "[ ]") are removed. */
export function parseActionItems(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s+/, '').trim())
    .filter(Boolean);
}

export interface TaskPrefill { client_id: string; task: string; notes: string; label: string | null }

/** Title = the action text (truncated to the field limit, full text then goes to Notes); Notes = "From note: <label>". */
export function prefillFor(item: string, noteLabel: string, clientId: string, position: { index: number; total: number }): TaskPrefill {
  const truncated = item.length > TASK_TITLE_MAX;
  const task = truncated ? `${item.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : item;
  const notes = `From note: ${noteLabel}${truncated ? `\n\n${item}` : ''}`;
  return { client_id: clientId, task, notes, label: position.total > 1 ? `Action item ${position.index + 1} of ${position.total}` : null };
}

/** "<subject or note type>, <local date>" for the Notes line of the new task. */
export function noteLabelOf(subject: string | null, noteType: string, timestamp: string): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${subject || noteType}${date ? `, ${date}` : ''}`;
}

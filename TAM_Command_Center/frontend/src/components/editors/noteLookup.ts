import type { DataSource } from '../../data/DataSource';
import type { Note } from '../../types';

/** Notes are not part of /api/state; find one by paging the account timeline (bounded). */
export async function findNote(ds: DataSource, clientId: string, noteId: string): Promise<Note | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 12; page++) {
    const r = await ds.getActivity(clientId, { filter: 'all', limit: 100, cursor });
    for (const e of r.items) if (e.entry_kind === 'note' && e.note.id === noteId) return e.note;
    if (!r.next_cursor) return null;
    cursor = r.next_cursor;
  }
  return null;
}

/** datetime-local value (local time) <-> ISO instant */
export function instantToLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function localInputToInstant(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

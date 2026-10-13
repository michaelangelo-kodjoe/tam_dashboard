import type { DataSource } from '../../data/DataSource';
import type { Note } from '../../types';

/** One note by id (GET /api/note/{id}, FE-AC-1). Null if it is gone or belongs to another account. */
export async function findNote(ds: DataSource, clientId: string, noteId: string): Promise<Note | null> {
  const n = await ds.getNote(noteId);
  return n && n.client_id === clientId ? n : null;
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

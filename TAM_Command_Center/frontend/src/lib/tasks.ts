import type { Task, TaskInput } from '../types';

const PRIO: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

/** Overdue first, then priority High->Low, then due ascending (nulls last). Open = not Complete, not archived. */
export function topOpenTasks(tasks: Task[], today: string, limit = 8): Task[] {
  const open = tasks.filter((t) => !t.archived && t.status !== 'Complete');
  const overdue = (t: Task) => (t.due != null && t.due < today ? 0 : 1);
  return [...open]
    .sort((a, b) => overdue(a) - overdue(b) || (PRIO[a.priority] ?? 3) - (PRIO[b.priority] ?? 3) || (a.due == null ? (b.due == null ? 0 : 1) : b.due == null ? -1 : a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
    .slice(0, limit);
}

/** A Task row as an update payload (carries expected_row_version, D-11). */
export function taskToInput(t: Task): TaskInput {
  return {
    id: t.id, task: t.task, client_id: t.client_id, category: t.category, priority: t.priority, due: t.due,
    next_update: t.next_update, status: t.status, waiting: t.waiting, notes: t.notes, expected_row_version: t.row_version,
  };
}

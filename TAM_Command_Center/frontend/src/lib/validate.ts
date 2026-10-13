// Client-side mirror of the server validation rules (docs/01_PM_SPEC.md §3.2, US-6.2, US-7.3).
// Returns a field -> message map; empty means valid. Strings are trimmed by the caller via `clean`.
import {
  NOTE_TYPES,
  TASK_CATEGORIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type AccountInput,
  type ContactInput,
  type NoteInput,
  type TaskInput,
} from '../types';
import { isISODate } from './dates';

export type FieldErrors = Record<string, string>;

export function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function maxLen(errors: FieldErrors, key: string, v: string | null | undefined, n: number, label: string) {
  if (v && v.length > n) errors[key] = `${label} must be ${n.toLocaleString('en-US')} characters or fewer.`;
}

export function validateTask(t: TaskInput): FieldErrors {
  const e: FieldErrors = {};
  if (!clean(t.task)) e.task = 'Task is required.';
  maxLen(e, 'task', t.task, 500, 'Task');
  if (!TASK_CATEGORIES.includes(t.category)) e.category = 'Choose a category.';
  if (!TASK_PRIORITIES.includes(t.priority)) e.priority = 'Choose a priority.';
  if (!TASK_STATUSES.includes(t.status)) e.status = 'Choose a status.';
  if (t.due && !isISODate(t.due)) e.due = 'Enter a valid date.';
  if (t.next_update && !isISODate(t.next_update)) e.next_update = 'Enter a valid date.';
  maxLen(e, 'notes', t.notes, 20000, 'Notes');
  return e;
}

export function validateNote(n: NoteInput): FieldErrors {
  const e: FieldErrors = {};
  if (!n.client_id) e.client_id = 'Choose an account.';
  if (!NOTE_TYPES.includes(n.note_type)) e.note_type = 'Choose a note type.';
  if (!clean(n.subject) && !clean(n.body)) {
    e.subject = 'Add a subject or a body.';
  }
  maxLen(e, 'subject', n.subject, 200, 'Subject');
  maxLen(e, 'body', n.body, 50000, 'Body');
  maxLen(e, 'action_items', n.action_items, 10000, 'Action items');
  if (!n.timestamp || Number.isNaN(Date.parse(n.timestamp))) e.timestamp = 'Enter a valid date and time.';
  return e;
}

export function validateContact(c: ContactInput): FieldErrors {
  const e: FieldErrors = {};
  const name = clean(c.name);
  if (!name) e.name = 'Name is required.';
  else if (CONTROL.test(name)) e.name = 'Name contains invalid characters.';
  const email = clean(c.email);
  if (email && !EMAIL.test(email)) e.email = 'Enter an email like name@example.com.';
  maxLen(e, 'name', c.name, 200, 'Name');
  return e;
}

export function validateAccount(a: AccountInput): FieldErrors {
  const e: FieldErrors = {};
  const name = clean(a.name);
  if (!name) e.name = 'Account name is required.';
  else if (CONTROL.test(name)) e.name = 'Name contains invalid characters.';
  maxLen(e, 'name', a.name, 200, 'Name');
  if (a.next_contact && !isISODate(a.next_contact)) e.next_contact = 'Enter a valid date.';
  maxLen(e, 'notes', a.notes, 20000, 'Notes');
  return e;
}

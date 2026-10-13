import { Fragment, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Cog, FileText, Pencil, Phone, Trash2, UsersRound } from 'lucide-react';
import { Button } from '../ui/Button';
import { RichText } from '../ui/Feedback';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { useData } from '../../store/DataContext';
import type { ActivityEntry, ActivityNoteEntry, ActivitySystemEntry, Note } from '../../types';
import { accountPath } from '../../lib/links';
import { dayHeading, formatTimestamp, instantLocalDate } from '../../lib/dates';
import { cx } from '../../lib/cx';

const NOTE_ICON = { 'Meeting Note': UsersRound, 'Call Note': Phone, 'General Note': FileText } as const;
const NOTE_TONE = { 'Meeting Note': 'accent', 'Call Note': 'info', 'General Note': 'muted' } as const;

function noteLink(loc: { pathname: string; search: string }, id: string) {
  const p = new URLSearchParams(loc.search);
  p.set('note', id);
  return `${loc.pathname}?${p.toString()}`;
}

export function NoteEntry({ entry, tz, today, onDeleted }: { entry: ActivityNoteEntry; tz: 'local' | 'gmt'; today: string; onDeleted?: () => void }) {
  const n = entry.note;
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const loc = useLocation();
  const { ds, bump } = useData();
  const toast = useToast();
  const Icon = NOTE_ICON[n.note_type];
  const long = (n.body?.length ?? 0) > 360 || (n.body?.split('\n').length ?? 0) > 6;

  const del = async () => {
    setBusy(true);
    try {
      await ds.deleteNote({ id: n.id, confirm: true });
      bump();
      onDeleted?.();
      toast.push({ kind: 'success', message: 'Note deleted', detail: 'A safety backup was created first.' });
      setConfirm(false);
    } catch (e) {
      toast.push({ kind: 'error', message: 'Could not delete the note.', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={cx('note', `note--${NOTE_TONE[n.note_type]}`)} aria-label={`${n.note_type}: ${n.subject ?? ''}`}>
      <header className="note__head">
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="note__icon" />
        <span className="note__type">{n.note_type.replace(' Note', ' note')}</span>
        <time className="note__time num muted" dateTime={n.timestamp}>{formatTimestamp(n.timestamp, tz, today)}</time>
        {n.source !== 'GUI' && <span className="tag" title="Where this note came from">{n.source}</span>}
        <span className="note__actions">
          <Link className="btn btn--icon btn--sm" to={noteLink(loc, n.id)} aria-label={`Edit note: ${n.subject ?? n.note_type}`} title="Edit">
            <span className="btn__icon" aria-hidden="true"><Pencil size={16} strokeWidth={1.5} /></span>
          </Link>
          <Button variant="icon" size="sm" aria-label={`Delete note: ${n.subject ?? n.note_type}`} title="Delete" onClick={() => setConfirm(true)} icon={<Trash2 size={16} strokeWidth={1.5} />} />
        </span>
      </header>
      {n.subject && <h3 className="note__subject">{n.subject}</h3>}
      {n.body && <RichText text={n.body} className={cx('note__body', long && !expanded && 'is-clamped')} />}
      {long && (
        <button type="button" className="linkbtn" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {n.action_items && (
        <div className="note__actionitems">
          <span className="label">Action items</span>
          <RichText text={n.action_items} />
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${n.note_type.toLowerCase()}?`}
          objectName={n.subject || n.note_type}
          description="A safety backup is created first. This cannot be undone in the app."
          confirmLabel="Delete note"
          busy={busy}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void del()}
        />
      )}
    </article>
  );
}

function systemLink(e: ActivitySystemEntry, clientId: string): string | null {
  if (e.server_name) return accountPath(clientId, 'infrastructure', { server: e.server_name });
  if (e.object_type === 'task' && !/ deleted:/.test(e.sentence)) return accountPath(clientId, 'tasks', { task: e.object_id });
  if (e.object_type === 'contact' && !/removed:/.test(e.sentence)) return accountPath(clientId, 'contacts', { contact: e.object_id });
  return null;
}

/** One 28px line, no container, no edit or delete controls (guidelines §9). */
export function SystemEventEntry({ entry, clientId, tz, today }: { entry: ActivitySystemEntry; clientId: string; tz: 'local' | 'gmt'; today: string }) {
  const link = systemLink(entry, clientId);
  return (
    <div className="sysevent">
      <Cog size={14} strokeWidth={1.5} aria-hidden="true" className="sysevent__icon" />
      <span className="sysevent__label label">System</span>
      <time className="sysevent__time num muted" dateTime={entry.ts}>{formatTimestamp(entry.ts, tz, today)}</time>
      {link ? <Link to={link} className="sysevent__text truncate" title={entry.sentence}>{entry.sentence}</Link> : <span className="sysevent__text truncate muted" title={entry.sentence}>{entry.sentence}</span>}
    </div>
  );
}

export function Timeline({ entries, clientId, tz, today }: { entries: ActivityEntry[]; clientId: string; tz: 'local' | 'gmt'; today: string }) {
  let lastDay = '';
  return (
    <div className="timeline">
      {entries.map((e) => {
        const day = instantLocalDate(e.ts);
        const head = day !== lastDay;
        lastDay = day;
        return (
          <Fragment key={e.entry_key}>
            {head && <h3 className="timeline__day label">{dayHeading(day, today)}</h3>}
            {e.entry_kind === 'note' ? <NoteEntry entry={e} tz={tz} today={today} /> : <SystemEventEntry entry={e} clientId={clientId} tz={tz} today={today} />}
          </Fragment>
        );
      })}
    </div>
  );
}

export type { Note };

import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Field, TextArea, TextInput } from '../ui/Fields';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorBanner, SkeletonRows } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { ConflictBanner, FormError, ReadOnlyRow, focusFirstInvalid, useSaveFlow } from './shared';
import { findNote, instantToLocalInput, localInputToInstant } from './noteLookup';
import { useApp, useData } from '../../store/DataContext';
import { NOTE_TYPES, type Note, type NoteInput, type NoteType } from '../../types';
import { clean, validateNote } from '../../lib/validate';
import { useUI } from '../../store/UIContext';
import { noteLabelOf } from '../../lib/actionItems';
import { formatTimestamp } from '../../lib/dates';

interface FormState { note_type: NoteType; timestamp: string; subject: string; body: string; action_items: string }
const blank = (type: NoteType): FormState => ({ note_type: type, timestamp: instantToLocalInput(new Date().toISOString()), subject: '', body: '', action_items: '' });
const fromNote = (n: Note): FormState => ({ note_type: n.note_type, timestamp: instantToLocalInput(n.timestamp), subject: n.subject ?? '', body: n.body ?? '', action_items: n.action_items ?? '' });

export function NoteDrawer({ noteId, clientId, newType, onClose }: { noteId: string; clientId: string; newType?: NoteType; onClose: () => void }) {
  const { ds, bump } = useData();
  const { accountById, settings } = useApp();
  const toast = useToast();
  const { offerActionItems } = useUI();
  const isNew = noteId === 'new';
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [form, setForm] = useState<FormState>(() => blank(newType ?? 'Meeting Note'));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = useSaveFlow();
  const bodyRef = useRef<HTMLDivElement>(null);
  const initial = useRef<FormState>(form);
  const account = accountById(clientId);

  useEffect(() => {
    if (isNew) return;
    let live = true;
    findNote(ds, clientId, noteId).then(
      (n) => {
        if (!live) return;
        if (!n) { setLoadError(new Error('This note no longer exists.')); setLoading(false); return; }
        setNote(n);
        const f = fromNote(n);
        initial.current = f;
        setForm(f);
        setLoading(false);
      },
      (e) => { if (live) { setLoadError(e); setLoading(false); } },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, clientId, ds]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial.current), [form]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const build = (version?: number): NoteInput => ({
    id: note?.id, client_id: clientId, note_type: form.note_type, timestamp: localInputToInstant(form.timestamp),
    subject: clean(form.subject), body: clean(form.body), action_items: clean(form.action_items), expected_row_version: isNew ? undefined : (version ?? note?.row_version),
  });

  const save = async (overwrite = false) => {
    const errs = validateNote(build());
    flow.setFieldErrors(errs);
    if (Object.keys(errs).length) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
    let version = note?.row_version;
    if (overwrite && note) version = (await findNote(ds, clientId, note.id))?.row_version ?? version;
    const input = build(version);
    const changed = isNew || (input.action_items ?? '') !== (clean(initial.current.action_items) ?? '');
    const ok = await flow.run(async () => {
      await ds.saveNote(input);
      bump();
      toast.push({ kind: 'success', message: isNew ? 'Note saved' : 'Note updated' });
    });
    if (ok && changed && input.action_items) offerActionItems({ clientId, noteLabel: noteLabelOf(input.subject, input.note_type, input.timestamp), actionItems: input.action_items });
    if (ok) onClose();
    else setTimeout(() => focusFirstInvalid(bodyRef.current), 0);
  };

  const reload = async () => {
    if (!note) return;
    const n = await findNote(ds, clientId, note.id);
    if (!n) { onClose(); return; }
    setNote(n);
    const f = fromNote(n);
    initial.current = f;
    setForm(f);
    flow.clear();
  };

  const doDelete = async () => {
    if (!note) return;
    const ok = await flow.run(async () => {
      await ds.deleteNote({ id: note.id, confirm: true });
      bump();
      toast.push({ kind: 'success', message: 'Note deleted', detail: 'A safety backup was created first.' });
    });
    if (ok) { setConfirmDelete(false); onClose(); }
  };

  const e = flow.fieldErrors;
  return (
    <>
      <Drawer
        kind={form.note_type}
        title={isNew ? `New ${form.note_type.toLowerCase()}` : note?.subject || form.note_type}
        onClose={onClose}
        dirty={dirty}
        busy={flow.busy}
        onSubmitShortcut={() => void save()}
        footer={
          <>
            <div className="foot__left">
              {note && <Button variant="danger" size="sm" icon={<Trash2 size={16} strokeWidth={1.5} />} onClick={() => setConfirmDelete(true)} disabled={flow.busy}>Delete note</Button>}
            </div>
            <Button variant="secondary" onClick={onClose} disabled={flow.busy}>Cancel</Button>
            <Button variant="primary" busy={flow.busy} onClick={() => void save()} disabled={loading || !!loadError}>Save note</Button>
          </>
        }
      >
        <div ref={bodyRef} className="form">
          {loading && <SkeletonRows rows={6} label="Loading note" />}
          {loadError ? <ErrorBanner error={loadError} title="Could not open this note" /> : null}
          {!loading && !loadError && (
            <>
              {flow.stale && <ConflictBanner onReload={reload} onOverwrite={() => void save(true)} busy={flow.busy} />}
              <FormError message={flow.formError} />
              <ReadOnlyRow label="Account" value={account?.name ?? 'Unknown account'} />
              <div className="field">
                <span className="field__label" id="note-type-label">Type</span>
                <SegmentedControl label="Note type" value={form.note_type} onChange={(v) => set('note_type', v)} options={NOTE_TYPES.map((t) => ({ value: t, label: t.replace(' Note', '') }))} />
              </div>
              <Field label="Timestamp" required error={e.timestamp}>
                {(p) => <input id={p.id} type="datetime-local" className="input num" value={form.timestamp} onChange={(ev) => set('timestamp', ev.target.value)} aria-invalid={p.invalid || undefined} aria-describedby={p.describedBy} aria-required />}
              </Field>
              <Field label="Subject" error={e.subject}>
                {(p) => <TextInput id={p.id} value={form.subject} maxLength={300} onChange={(ev) => set('subject', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} autoFocus data-autofocus />}
              </Field>
              <Field label="Body" error={e.body}>
                {(p) => <TextArea id={p.id} value={form.body} onChange={(ev) => set('body', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Action items" error={e.action_items}>
                {(p) => <TextArea id={p.id} value={form.action_items} onChange={(ev) => set('action_items', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              <ReadOnlyRow label="Source" value={note?.source ?? 'GUI'} />
              {note && (
                <div className="readonly-group">
                  <ReadOnlyRow label="Created" value={formatTimestamp(note.created_at, settings.time_display)} />
                  <ReadOnlyRow label="Updated" value={formatTimestamp(note.updated_at, settings.time_display)} />
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>
      {confirmDelete && note && (
        <ConfirmDialog
          title={`Delete ${note.note_type.toLowerCase()}?`}
          objectName={note.subject || note.note_type}
          description="A safety backup is created first. This cannot be undone in the app."
          confirmLabel="Delete note"
          busy={flow.busy}
          error={flow.formError}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </>
  );
}

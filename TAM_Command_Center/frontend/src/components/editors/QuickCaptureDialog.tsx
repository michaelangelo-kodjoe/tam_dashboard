import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { AccountPicker } from '../ui/AccountPicker';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Checkbox } from '../ui/Checkbox';
import { DateField, Field, TextArea, TextInput } from '../ui/Fields';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';
import { FormError, focusFirstInvalid, useSaveFlow } from './shared';
import { instantToLocalInput, localInputToInstant } from './noteLookup';
import { useApp, useData } from '../../store/DataContext';
import { noteLabelOf } from '../../lib/actionItems';
import { useUI, type CaptureType } from '../../store/UIContext';
import { TASK_CATEGORIES, TASK_PRIORITIES, type MutationResult, type Note, type Task, type TaskInput } from '../../types';
import { accountPath } from '../../lib/links';
import { clean, validateNote, validateTask } from '../../lib/validate';

const TYPES: { value: CaptureType; label: string }[] = [
  { value: 'task', label: 'Task' },
  { value: 'follow_up', label: 'Client follow-up' },
  { value: 'Meeting Note', label: 'Meeting note' },
  { value: 'Call Note', label: 'Call note' },
  { value: 'General Note', label: 'General note' },
];

/** One global Capture dialog (spec §31, US-10.1). Account first; account required for notes + follow-ups. */
export function QuickCaptureDialog() {
  const { capture, closeCapture } = useUI();
  if (!capture.open) return null;
  return <CaptureForm prefill={capture.prefill} onClose={closeCapture} />;
}

function CaptureForm({ prefill, onClose }: { prefill: { type?: CaptureType; clientId?: string | null }; onClose: () => void }) {
  const { ds, bump } = useData();
  const { accounts, state, today } = useApp();
  const toast = useToast();
  const { offerActionItems } = useUI();
  const flow = useSaveFlow();
  const bodyRef = useRef<HTMLDivElement>(null);

  const [type, setType] = useState<CaptureType>(prefill.type ?? 'task');
  const [clientId, setClientId] = useState<string | null>(prefill.clientId ?? null);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [due, setDue] = useState<string | null>(null);
  const [priority, setPriority] = useState<string>('Medium');
  const [category, setCategory] = useState<string>('Other');
  const [updateTouch, setUpdateTouch] = useState(true);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [actions, setActions] = useState('');
  const [ts, setTs] = useState(() => instantToLocalInput(new Date().toISOString()));
  const [discard, setDiscard] = useState(false);

  const isNote = type === 'Meeting Note' || type === 'Call Note' || type === 'General Note';
  const followUpTitle = useMemo(() => {
    const acct = accounts.find((a) => a.id === clientId);
    const primary = state.contacts.find((c) => c.client_id === clientId && c.is_primary);
    return `Follow up with ${primary?.name ?? acct?.name ?? 'client'}`;
  }, [accounts, state.contacts, clientId]);

  // Client Follow-Up pre-fills the title until the user edits it
  useEffect(() => {
    if (type === 'follow_up' && !titleTouched) setTitle(followUpTitle);
  }, [type, followUpTitle, titleTouched]);

  const dirty = !!(title.trim() && (type !== 'follow_up' || titleTouched)) || !!(subject || body || actions) || (clientId !== (prefill.clientId ?? null)) || !!due;

  const requestClose = () => (dirty ? setDiscard(true) : onClose());

  const submit = async () => {
    const errs: Record<string, string> = {};
    let result: MutationResult<Task | Note> | null = null;
    if (!isNote) {
      const input: TaskInput = {
        task: title,
        client_id: clientId,
        category: type === 'follow_up' ? 'Client Follow-Up' : (category as TaskInput['category']),
        priority: priority as TaskInput['priority'],
        due,
        next_update: null,
        status: 'Not Started',
        waiting: null,
        notes: null,
        update_next_contact: type === 'follow_up' ? updateTouch : undefined,
      };
      Object.assign(errs, validateTask(input));
      if (type === 'follow_up') {
        if (!clientId) errs.client_id = 'Choose an account.';
        if (!due) errs.due = 'A due date is required for a follow-up.';
      }
      flow.setFieldErrors(errs);
      if (Object.keys(errs).length) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
      const ok = await flow.run(async () => { result = await ds.saveTask(input); });
      if (!ok || !result) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
      const t = (result as MutationResult<Task>).item;
      bump();
      toast.push({
        kind: 'success',
        message: type === 'follow_up' ? 'Follow-up created' : 'Task created',
        detail: (result as MutationResult<Task>).side_effects.includes('next_contact_updated') ? 'Next client touch updated.' : undefined,
        action: { label: 'View', to: t.client_id ? accountPath(t.client_id, 'tasks', { task: t.id }) : `/tasks?task=${t.id}` },
      });
      onClose();
      return;
    }
    const input = {
      client_id: clientId ?? '',
      note_type: type as 'Meeting Note' | 'Call Note' | 'General Note',
      timestamp: localInputToInstant(ts),
      subject: clean(subject),
      body: clean(body),
      action_items: clean(actions),
    };
    Object.assign(errs, validateNote(input));
    flow.setFieldErrors(errs);
    if (Object.keys(errs).length) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
    let saved: Note | null = null;
    const ok = await flow.run(async () => { saved = (await ds.saveNote(input)).item; });
    if (!ok || !saved) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
    bump();
    if (input.action_items) offerActionItems({ clientId: input.client_id, noteLabel: noteLabelOf(input.subject, input.note_type, input.timestamp), actionItems: input.action_items });
    toast.push({ kind: 'success', message: `${type} saved`, action: { label: 'View', to: accountPath(input.client_id, 'activity') } });
    onClose();
  };

  const e = flow.fieldErrors;
  return (
    <>
      <Dialog
        title="Quick capture"
        width={600}
        onClose={requestClose}
        closable={!flow.busy && !discard}
        closeOnScrim={!dirty}
        onSubmitShortcut={discard ? undefined : () => void submit()}
        footer={
          <>
            <span className="foot__hint muted">Ctrl+Enter to save</span>
            <Button variant="secondary" onClick={requestClose} disabled={flow.busy}>Cancel</Button>
            <Button variant="primary" busy={flow.busy} onClick={() => void submit()}>Save {type === 'task' ? 'task' : type === 'follow_up' ? 'follow-up' : 'note'}</Button>
          </>
        }
      >
        <div ref={bodyRef} className="form">
          <div className="field">
            <span className="field__label">Type</span>
            <SegmentedControl label="Capture type" value={type} onChange={setType} options={TYPES} />
          </div>
          <FormError message={flow.formError} />
          <Field label="Account" required={type !== 'task'} error={e.client_id}>
            {(p) => (
              <AccountPicker id={p.id} accounts={accounts} nullable={type === 'task'} value={clientId} onChange={setClientId} placeholder={type === 'task' ? 'No account' : 'Search accounts…'} aria-invalid={p.invalid} aria-describedby={p.describedBy} aria-required={p.required} autoFocus={!prefill.clientId} />
            )}
          </Field>
          {!isNote ? (
            <>
              <Field label={type === 'follow_up' ? 'Follow-up task' : 'Task'} required error={e.task}>
                {(p) => <TextInput id={p.id} value={title} onChange={(ev) => { setTitle(ev.target.value); setTitleTouched(true); }} invalid={p.invalid} aria-describedby={p.describedBy} aria-required data-autofocus={prefill.clientId ? true : undefined} />}
              </Field>
              <Field label="Due" required={type === 'follow_up'} error={e.due}>
                {(p) => <DateField id={p.id} value={due} onChange={setDue} today={today} invalid={p.invalid} describedBy={p.describedBy} required={type === 'follow_up'} />}
              </Field>
              {type === 'task' ? (
                <div className="form__row">
                  <Field label="Priority">{(p) => <Select id={p.id} value={priority} onChange={(v) => v && setPriority(v)} options={TASK_PRIORITIES.map((v) => ({ value: v, label: v }))} />}</Field>
                  <Field label="Category">{(p) => <Select id={p.id} value={category} onChange={(v) => v && setCategory(v)} options={TASK_CATEGORIES.map((v) => ({ value: v, label: v }))} />}</Field>
                </div>
              ) : (
                <>
                  <Field label="Priority">{(p) => <Select id={p.id} value={priority} onChange={(v) => v && setPriority(v)} options={TASK_PRIORITIES.map((v) => ({ value: v, label: v }))} />}</Field>
                  <Checkbox label={<>Update Next Client Touch to this date <span className="muted">(only if earlier than the current one)</span></>} checked={updateTouch} onChange={(ev) => setUpdateTouch(ev.target.checked)} />
                </>
              )}
            </>
          ) : (
            <>
              <Field label="Subject" error={e.subject}>
                {(p) => <TextInput id={p.id} value={subject} maxLength={300} onChange={(ev) => setSubject(ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} data-autofocus={prefill.clientId ? true : undefined} />}
              </Field>
              <Field label="Body" error={e.body}>
                {(p) => <TextArea id={p.id} value={body} onChange={(ev) => setBody(ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Action items" error={e.action_items}>
                {(p) => <TextArea id={p.id} value={actions} onChange={(ev) => setActions(ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Timestamp" required error={e.timestamp}>
                {(p) => <input id={p.id} type="datetime-local" className="input num" value={ts} onChange={(ev) => setTs(ev.target.value)} aria-invalid={p.invalid || undefined} aria-describedby={p.describedBy} aria-required />}
              </Field>
            </>
          )}
        </div>
      </Dialog>
      {discard && (
        <ConfirmDialog
          title="Discard changes?"
          description="You have unsaved input in Quick capture."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          cancelVariant="primary"
          onCancel={() => setDiscard(false)}
          onConfirm={() => { setDiscard(false); onClose(); }}
        />
      )}
    </>
  );
}

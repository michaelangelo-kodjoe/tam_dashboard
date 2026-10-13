import { useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Field, TextInput } from '../ui/Fields';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorBanner } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { ConflictBanner, FormError, focusFirstInvalid, useSaveFlow } from './shared';
import { useApp, useData } from '../../store/DataContext';
import type { Contact, ContactInput } from '../../types';
import { clean, validateContact } from '../../lib/validate';

interface FormState { name: string; role: string; team: string; email: string; is_primary: boolean }
const from = (c: Contact | null): FormState => ({ name: c?.name ?? '', role: c?.role ?? '', team: c?.team ?? '', email: c?.email ?? '', is_primary: c?.is_primary ?? false });

export function ContactDrawer({ contactId, clientId, onClose }: { contactId: string; clientId: string; onClose: () => void }) {
  const { ds, bump } = useData();
  const { state, accountById } = useApp();
  const toast = useToast();
  const isNew = contactId === 'new';
  const contact = isNew ? null : state.contacts.find((c) => c.id === contactId) ?? null;
  const [form, setForm] = useState<FormState>(() => from(contact));
  const initial = useRef(form);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = useSaveFlow();
  const bodyRef = useRef<HTMLDivElement>(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial.current), [form]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const currentPrimary = state.contacts.find((c) => c.client_id === clientId && c.is_primary && c.id !== contact?.id);

  const build = (version?: number): ContactInput => ({
    id: contact?.id, client_id: clientId, name: form.name, role: clean(form.role), team: clean(form.team), email: clean(form.email),
    is_primary: form.is_primary, expected_row_version: isNew ? undefined : (version ?? contact?.row_version),
  });

  const save = async (overwrite = false) => {
    const errs = validateContact(build());
    flow.setFieldErrors(errs);
    if (Object.keys(errs).length) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
    const ok = await flow.run(async () => {
      let version = contact?.row_version;
      if (overwrite && contact) {
        const fresh = (await ds.getState()).contacts.find((c) => c.id === contact.id);
        version = fresh?.row_version ?? version;
      }
      const r = await ds.saveContact(build(version));
      bump();
      toast.push({ kind: 'success', message: r.message ?? (isNew ? 'Contact added' : 'Contact saved') });
    });
    if (ok) onClose();
    else setTimeout(() => focusFirstInvalid(bodyRef.current), 0);
  };

  const doDelete = async () => {
    if (!contact) return;
    const ok = await flow.run(async () => {
      await ds.deleteContact({ id: contact.id, confirm: true });
      bump();
      toast.push({ kind: 'success', message: 'Contact deleted', detail: 'A safety backup was created first.' });
    });
    if (ok) { setConfirmDelete(false); onClose(); }
  };

  const reload = async () => {
    if (!contact) return;
    const fresh = (await ds.getState()).contacts.find((c) => c.id === contact.id);
    if (!fresh) { onClose(); return; }
    const f = from(fresh);
    initial.current = f;
    setForm(f);
    flow.clear();
    bump();
  };

  const e = flow.fieldErrors;
  const notFound = !isNew && !contact;
  return (
    <>
      <Drawer
        kind="Contact"
        title={isNew ? 'New contact' : contact?.name}
        onClose={onClose}
        dirty={dirty}
        busy={flow.busy}
        onSubmitShortcut={() => void save()}
        footer={
          <>
            <div className="foot__left">
              {contact && <Button variant="danger" size="sm" icon={<Trash2 size={16} strokeWidth={1.5} />} onClick={() => setConfirmDelete(true)} disabled={flow.busy}>Delete contact</Button>}
            </div>
            <Button variant="secondary" onClick={onClose} disabled={flow.busy}>Cancel</Button>
            <Button variant="primary" busy={flow.busy} onClick={() => void save()} disabled={notFound}>Save contact</Button>
          </>
        }
      >
        <div ref={bodyRef} className="form">
          {notFound ? <ErrorBanner error={new Error('This contact no longer exists.')} title="Could not open this contact" /> : (
            <>
              {flow.stale && <ConflictBanner onReload={reload} onOverwrite={() => void save(true)} busy={flow.busy} />}
              <FormError message={flow.formError} />
              <p className="muted">Account: <strong className="text-strong">{accountById(clientId)?.name}</strong></p>
              <Field label="Name" required error={e.name}>
                {(p) => <TextInput id={p.id} value={form.name} onChange={(ev) => set('name', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} aria-required autoFocus data-autofocus />}
              </Field>
              <Field label="Role" error={e.role}>
                {(p) => <TextInput id={p.id} value={form.role} onChange={(ev) => set('role', ev.target.value)} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Team" error={e.team}>
                {(p) => <TextInput id={p.id} value={form.team} onChange={(ev) => set('team', ev.target.value)} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Email" error={e.email}>
                {(p) => <TextInput id={p.id} type="email" value={form.email} onChange={(ev) => set('email', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              <div className="field">
                <Checkbox label="Primary contact" checked={form.is_primary} onChange={(ev) => set('is_primary', ev.target.checked)} />
                {form.is_primary && currentPrimary && <p className="field__hint">{currentPrimary.name} stops being primary when you save.</p>}
              </div>
            </>
          )}
        </div>
      </Drawer>
      {confirmDelete && contact && (
        <ConfirmDialog
          title="Delete contact?"
          objectName={contact.name}
          description="A safety backup is created first. This cannot be undone in the app."
          confirmLabel="Delete contact"
          busy={flow.busy}
          error={flow.formError}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </>
  );
}

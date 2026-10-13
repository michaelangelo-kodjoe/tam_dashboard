import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { DateField, Field, TextArea, TextInput } from '../ui/Fields';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorBanner } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { ConflictBanner, FormError, focusFirstInvalid, useSaveFlow } from './shared';
import { useApp, useData } from '../../store/DataContext';
import type { AccountInput, ClientStatus } from '../../types';
import { clean, validateAccount } from '../../lib/validate';
import { accountPath } from '../../lib/links';

interface FormState { name: string; bpid: string; products: string; status: ClientStatus; next_contact: string | null; notes: string }

/** `accountId` is an account id or "new". Includes the danger zone (D-12). */
export function AccountDrawer({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { ds, bump } = useData();
  const { accountById, today } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const isNew = accountId === 'new';
  const account = isNew ? undefined : accountById(accountId);
  const [form, setForm] = useState<FormState>(() => ({
    name: account?.name ?? '', bpid: account?.bpid ?? '', products: account?.products ?? '', status: account?.status ?? 'Active',
    next_contact: account?.next_contact ?? null, notes: account?.notes ?? '',
  }));
  const initial = useRef(form);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = useSaveFlow();
  const bodyRef = useRef<HTMLDivElement>(null);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial.current), [form]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const build = (version?: number): AccountInput => ({
    id: account?.id, name: form.name, bpid: clean(form.bpid), products: clean(form.products), status: form.status,
    next_contact: form.next_contact, notes: clean(form.notes), expected_row_version: isNew ? undefined : (version ?? account?.row_version),
  });

  const save = async (overwrite = false) => {
    const errs = validateAccount(build());
    flow.setFieldErrors(errs);
    if (Object.keys(errs).length) { setTimeout(() => focusFirstInvalid(bodyRef.current), 0); return; }
    let createdId: string | null = null;
    const ok = await flow.run(async () => {
      let version = account?.row_version;
      if (overwrite && account) version = (await ds.getState()).accounts.find((a) => a.id === account.id)?.row_version ?? version;
      const r = await ds.saveAccount(build(version));
      createdId = r.item.id;
      bump();
      toast.push({ kind: 'success', message: isNew ? 'Account created' : 'Account saved' });
    });
    if (ok) {
      onClose();
      if (isNew && createdId) navigate(accountPath(createdId));
    } else setTimeout(() => focusFirstInvalid(bodyRef.current), 0);
  };

  const reload = async () => {
    if (!account) return;
    const fresh = (await ds.getState()).accounts.find((a) => a.id === account.id);
    if (!fresh) { onClose(); return; }
    const f: FormState = { name: fresh.name, bpid: fresh.bpid ?? '', products: fresh.products ?? '', status: fresh.status, next_contact: fresh.next_contact, notes: fresh.notes ?? '' };
    initial.current = f;
    setForm(f);
    flow.clear();
    bump();
  };

  const doDelete = async () => {
    if (!account) return;
    const ok = await flow.run(async () => {
      await ds.deleteAccount({ id: account.id, confirm: true, confirm_name: account.name });
      bump();
      toast.push({ kind: 'success', message: `Deleted ${account.name}`, detail: 'A safety backup was created first.' });
    });
    if (ok) { setConfirmDelete(false); onClose(); navigate('/accounts'); }
  };

  const e = flow.fieldErrors;
  if (!isNew && !account) {
    return (
      <Drawer kind="Account" title="Account not found" onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
        <ErrorBanner error={new Error('This account no longer exists.')} title="Could not open this account" />
      </Drawer>
    );
  }
  return (
    <>
      <Drawer
        kind="Account"
        title={isNew ? 'New account' : account?.name}
        onClose={onClose}
        dirty={dirty}
        busy={flow.busy}
        onSubmitShortcut={() => void save()}
        footer={
          <>
            <div className="foot__left" />
            <Button variant="secondary" onClick={onClose} disabled={flow.busy}>Cancel</Button>
            <Button variant="primary" busy={flow.busy} onClick={() => void save()}>Save account</Button>
          </>
        }
      >
        <div ref={bodyRef} className="form">
          {flow.stale && <ConflictBanner onReload={reload} onOverwrite={() => void save(true)} busy={flow.busy} />}
          <FormError message={flow.formError} />
          <Field label="Account name" required error={e.name}>
            {(p) => <TextInput id={p.id} value={form.name} onChange={(ev) => set('name', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} aria-required autoFocus data-autofocus />}
          </Field>
          <Field label="BPID" error={e.bpid}>
            {(p) => <TextInput id={p.id} className="mono" value={form.bpid} onChange={(ev) => set('bpid', ev.target.value)} aria-describedby={p.describedBy} />}
          </Field>
          <Field label="Products" hint="Free text, e.g. Terminal, B-PIPE" error={e.products}>
            {(p) => <TextInput id={p.id} value={form.products} onChange={(ev) => set('products', ev.target.value)} aria-describedby={p.describedBy} />}
          </Field>
          <Field label="Status" required error={e.status}>
            {(p) => <Select id={p.id} value={form.status} onChange={(v) => v && set('status', v as ClientStatus)} options={[{ value: 'Active', label: 'Active' }, { value: 'Inactive', label: 'Inactive' }]} />}
          </Field>
          <Field label="Next client touch" error={e.next_contact}>
            {(p) => <DateField id={p.id} value={form.next_contact} onChange={(v) => set('next_contact', v)} today={today} invalid={p.invalid} describedBy={p.describedBy} />}
          </Field>
          <Field label="Notes" error={e.notes}>
            {(p) => <TextArea id={p.id} value={form.notes} onChange={(ev) => set('notes', ev.target.value)} aria-describedby={p.describedBy} />}
          </Field>
          {account && (
            <section className="danger-zone" aria-labelledby="dz-title">
              <h3 id="dz-title" className="label danger-text">Danger zone</h3>
              <p className="muted">Setting the status to Inactive keeps all history and is the recommended way to retire an account. Deleting removes its contacts, notes, tasks, upgrades and monitoring objects.</p>
              <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)} disabled={flow.busy}>Delete account…</Button>
            </section>
          )}
        </div>
      </Drawer>
      {confirmDelete && account && (
        <ConfirmDialog
          title="Delete account?"
          objectName={account.name}
          description="A safety backup is created first. This cannot be undone in the app. Contacts, notes, tasks, server upgrades and BAMS objects for this account are deleted; audit history is kept."
          typeToConfirm={account.name}
          confirmLabel="Delete account"
          busy={flow.busy}
          error={flow.formError}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </>
  );
}

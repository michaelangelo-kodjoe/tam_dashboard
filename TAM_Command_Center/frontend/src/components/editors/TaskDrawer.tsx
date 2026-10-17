import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { Drawer } from '../ui/Drawer';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { AccountPicker } from '../ui/AccountPicker';
import { DateField, Field, TextArea, TextInput } from '../ui/Fields';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorBanner, SkeletonRows } from '../ui/Feedback';
import { useToast } from '../ui/Toast';
import { ConflictBanner, FormError, ReadOnlyRow, focusFirstInvalid, useSaveFlow } from './shared';
import { useApp, useData } from '../../store/DataContext';
import { TASK_CATEGORIES, TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskInput } from '../../types';
import type { TaskPrefill } from '../../lib/actionItems';
import { clean, validateTask } from '../../lib/validate';
import { formatTimestamp } from '../../lib/dates';

const opt = (a: readonly string[]) => a.map((v) => ({ value: v, label: v }));

interface FormState {
  task: string; client_id: string | null; category: string; priority: string; status: string;
  due: string | null; next_update: string | null; waiting: string; notes: string;
}
const fromTask = (t: Task | null, clientId: string | null): FormState => ({
  task: t?.task ?? '', client_id: t ? t.client_id : clientId, category: t?.category ?? 'Other', priority: t?.priority ?? 'Medium',
  status: t?.status ?? 'Not Started', due: t?.due ?? null, next_update: t?.next_update ?? null, waiting: t?.waiting ?? '', notes: t?.notes ?? '',
});

/** Task create/edit drawer; `taskId` is a task id or "new". */
export function TaskDrawer({ taskId, defaultClientId, prefill, onClose }: { taskId: string; defaultClientId: string | null; prefill?: TaskPrefill | null; onClose: () => void }) {
  const { ds, bump } = useData();
  const { accounts, state, today, settings } = useApp();
  const toast = useToast();
  const isNew = taskId === 'new';
  const [loading, setLoading] = useState(!isNew);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [form, setForm] = useState<FormState>(() => (prefill ? { ...fromTask(null, prefill.client_id), task: prefill.task, notes: prefill.notes } : fromTask(null, defaultClientId)));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = useSaveFlow();
  const bodyRef = useRef<HTMLDivElement>(null);
  const initial = useRef<FormState>(form);

  // load the task: non-archived tasks come with the state bundle; archived ones are fetched
  useEffect(() => {
    if (isNew) return;
    let live = true;
    (async () => {
      try {
        let t: Task | undefined = state.tasks.find((x) => x.id === taskId);
        if (!t) t = (await ds.getTasks({ archived: true })).find((x) => x.id === taskId);
        if (!live) return;
        if (!t) { setLoadError(new Error('This task no longer exists.')); setLoading(false); return; }
        setTask(t);
        const f = fromTask(t, null);
        initial.current = f;
        setForm(f);
        setLoading(false);
      } catch (e) {
        if (live) { setLoadError(e); setLoading(false); }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, ds]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial.current), [form]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const buildInput = (withVersion: boolean, version?: number): TaskInput => ({
    id: task?.id,
    task: form.task,
    client_id: form.client_id,
    category: form.category as TaskInput['category'],
    priority: form.priority as TaskInput['priority'],
    due: form.due,
    next_update: form.next_update,
    status: form.status as TaskInput['status'],
    waiting: clean(form.waiting),
    notes: clean(form.notes),
    expected_row_version: withVersion ? (version ?? task?.row_version) : undefined,
  });

  const save = async (overwrite = false) => {
    const errs = validateTask(buildInput(false));
    flow.setFieldErrors(errs);
    if (Object.keys(errs).length) {
      setTimeout(() => focusFirstInvalid(bodyRef.current), 0);
      return;
    }
    let version = task?.row_version;
    if (overwrite && task) {
      const all = [...(await ds.getTasks({ archived: false })), ...(await ds.getTasks({ archived: true }))];
      version = all.find((x) => x.id === task.id)?.row_version ?? version;
    }
    const ok = await flow.run(async () => {
      const r = await ds.saveTask(buildInput(!isNew, version));
      bump();
      toast.push({ kind: 'success', message: isNew ? 'Task created' : 'Task saved' });
      void r;
    });
    if (ok) onClose();
    else setTimeout(() => focusFirstInvalid(bodyRef.current), 0);
  };

  const reload = async () => {
    if (!task) return;
    const all = [...(await ds.getTasks({ archived: false })), ...(await ds.getTasks({ archived: true }))];
    const t = all.find((x) => x.id === task.id);
    if (!t) { onClose(); return; }
    setTask(t);
    const f = fromTask(t, null);
    initial.current = f;
    setForm(f);
    flow.clear();
  };

  const toggleArchive = async () => {
    if (!task) return;
    const ok = await flow.run(async () => {
      await ds.archiveTask({ id: task.id, archived: !task.archived, expected_row_version: task.row_version });
      bump();
      toast.push({ kind: 'success', message: task.archived ? 'Task unarchived' : 'Task archived' });
    });
    if (ok) onClose();
  };

  const doDelete = async () => {
    if (!task) return;
    const ok = await flow.run(async () => {
      await ds.deleteTask({ id: task.id, confirm: true });
      bump();
      toast.push({ kind: 'success', message: 'Task deleted', detail: 'A safety backup was created first.' });
    });
    if (ok) { setConfirmDelete(false); onClose(); }
  };

  const e = flow.fieldErrors;
  const waitingHint = form.status === 'Waiting' && !form.waiting.trim() ? 'Status is Waiting: say who or what you are waiting on.' : undefined;

  return (
    <>
      <Drawer
        kind="Task"
        title={isNew ? (prefill?.label ? `New task · ${prefill.label}` : 'New task') : task?.task}
        onClose={onClose}
        dirty={dirty}
        busy={flow.busy}
        onSubmitShortcut={() => void save()}
        footer={
          <>
            <div className="foot__left">
              {task && (
                <>
                  <Button variant="ghost" size="sm" icon={task.archived ? <ArchiveRestore size={16} strokeWidth={1.5} /> : <Archive size={16} strokeWidth={1.5} />} onClick={toggleArchive} disabled={flow.busy}>
                    {task.archived ? 'Unarchive' : 'Archive'}
                  </Button>
                  <Button variant="danger" size="sm" icon={<Trash2 size={16} strokeWidth={1.5} />} onClick={() => setConfirmDelete(true)} disabled={flow.busy}>
                    Delete task
                  </Button>
                </>
              )}
            </div>
            <Button variant="secondary" onClick={onClose} disabled={flow.busy}>Cancel</Button>
            <Button variant="primary" busy={flow.busy} onClick={() => void save()} disabled={loading || !!loadError}>Save task</Button>
          </>
        }
      >
        <div ref={bodyRef} className="form">
          {loading && <SkeletonRows rows={6} label="Loading task" />}
          {loadError ? <ErrorBanner error={loadError} title="Could not open this task" /> : null}
          {!loading && !loadError && (
            <>
              {flow.stale && <ConflictBanner onReload={reload} onOverwrite={() => void save(true)} busy={flow.busy} />}
              <FormError message={flow.formError} />
              <Field label="Task" required error={e.task}>
                {(p) => <TextInput id={p.id} value={form.task} maxLength={600} onChange={(ev) => set('task', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} aria-required autoFocus data-autofocus />}
              </Field>
              <Field label="Account" error={e.client_id}>
                {(p) => <AccountPicker id={p.id} accounts={accounts} nullable value={form.client_id} onChange={(v) => set('client_id', v)} placeholder="No account" aria-describedby={p.describedBy} />}
              </Field>
              <div className="form__row">
                <Field label="Category" required error={e.category}>
                  {(p) => <Select id={p.id} value={form.category} onChange={(v) => v && set('category', v)} options={opt(TASK_CATEGORIES)} aria-invalid={p.invalid} />}
                </Field>
                <Field label="Priority" required error={e.priority}>
                  {(p) => <Select id={p.id} value={form.priority} onChange={(v) => v && set('priority', v)} options={opt(TASK_PRIORITIES)} aria-invalid={p.invalid} />}
                </Field>
              </div>
              <Field label="Status" required error={e.status}>
                {(p) => <Select id={p.id} value={form.status} onChange={(v) => v && set('status', v)} options={opt(TASK_STATUSES)} aria-invalid={p.invalid} />}
              </Field>
              <Field label="Due" error={e.due}>
                {(p) => <DateField id={p.id} value={form.due} onChange={(v) => set('due', v)} today={today} invalid={p.invalid} describedBy={p.describedBy} />}
              </Field>
              <Field label="Next update" error={e.next_update}>
                {(p) => <DateField id={p.id} value={form.next_update} onChange={(v) => set('next_update', v)} today={today} invalid={p.invalid} describedBy={p.describedBy} />}
              </Field>
              <Field label="Waiting on" hint={waitingHint} error={e.waiting}>
                {(p) => <TextInput id={p.id} value={form.waiting} onChange={(ev) => set('waiting', ev.target.value)} aria-describedby={p.describedBy} />}
              </Field>
              <Field label="Notes" error={e.notes}>
                {(p) => <TextArea id={p.id} value={form.notes} maxLength={20000} onChange={(ev) => set('notes', ev.target.value)} invalid={p.invalid} aria-describedby={p.describedBy} />}
              </Field>
              {task && (
                <div className="readonly-group">
                  <ReadOnlyRow label="Created" value={formatTimestamp(task.created_at, settings.time_display)} />
                  <ReadOnlyRow label="Updated" value={formatTimestamp(task.updated_at, settings.time_display)} />
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>
      {confirmDelete && task && (
        <ConfirmDialog
          title="Delete task?"
          objectName={task.task}
          description="A safety backup is created first. This cannot be undone in the app."
          confirmLabel="Delete task"
          busy={flow.busy}
          error={flow.formError}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      )}
    </>
  );
}

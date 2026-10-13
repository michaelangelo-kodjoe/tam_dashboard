import { useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { PageHeader, Panel } from '../components/ui/Panel';
import { Button, type ButtonVariant } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { AccountPicker } from '../components/ui/AccountPicker';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Checkbox } from '../components/ui/Checkbox';
import { StatusBadge, PriorityLabel } from '../components/ui/Badges';
import { Dialog } from '../components/ui/Dialog';
import { useToast } from '../components/ui/Toast';
import { Avatar, DatePill, DotRow, ProgressRing, Sparkline, StackBar } from '../components/ui/Instruments';
import { useApp } from '../store/DataContext';
import { useDocumentTitle } from '../lib/hooks';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'icon'];
const STATES = ['default', 'hover', 'active', 'focus', 'disabled', 'busy'] as const;

/** Component sandbox: every button state (forced via data-state), controls and badges. Route: /sandbox. */
export function SandboxPage() {
  useDocumentTitle('Component sandbox');
  const { accounts } = useApp();
  const toast = useToast();
  const [sel, setSel] = useState<string | null>('Medium');
  const [acc, setAcc] = useState<string | null>(null);
  const [seg, setSeg] = useState('a');
  const [dlg, setDlg] = useState(false);
  const [chk, setChk] = useState(true);

  return (
    <div className="page sandbox">
      <PageHeader title="Component sandbox" meta="Design system reference. Forced states use data-state; real states work on hover, press and Tab." />
      <Panel title="Buttons: variant by state">
        <div className="table-scroll">
          <table className="table table--compact sandbox__table">
            <caption className="sr-only">Button variants by state</caption>
            <thead>
              <tr><th scope="col">Variant</th>{STATES.map((s) => <th key={s} scope="col">{s}</th>)}</tr>
            </thead>
            <tbody>
              {VARIANTS.map((v) => (
                <tr key={v}>
                  <th scope="row">{v}</th>
                  {STATES.map((s) => (
                    <td key={s}>
                      <Button
                        variant={v}
                        data-state={s === 'default' ? undefined : s}
                        disabled={s === 'disabled'}
                        busy={s === 'busy'}
                        aria-label={v === 'icon' ? `${v} ${s}` : undefined}
                        icon={v === 'icon' ? <Pencil size={16} strokeWidth={1.5} /> : v === 'danger' ? <Trash2 size={16} strokeWidth={1.5} /> : undefined}
                      >
                        {v === 'icon' ? undefined : v === 'primary' ? 'Save task' : v === 'danger' ? 'Delete note' : 'Action'}
                      </Button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <div className="sandbox__grid">
        <Panel title="Select (select-only combobox)">
          <div className="form">
            <label className="field__label" id="sb-sel">Priority</label>
            <Select labelledBy="sb-sel" value={sel} onChange={setSel} clearable options={[{ value: 'High', label: 'High' }, { value: 'Medium', label: 'Medium' }, { value: 'Low', label: 'Low' }, { value: 'Disabled', label: 'Disabled option', disabled: true }]} />
            <label className="field__label" id="sb-sel2">Disabled</label>
            <Select labelledBy="sb-sel2" value="High" onChange={() => undefined} disabled options={[{ value: 'High', label: 'High' }]} />
          </div>
        </Panel>
        <Panel title="Account picker (editable combobox)">
          <div className="form">
            <label className="field__label" id="sb-acc">Account</label>
            <AccountPicker labelledBy="sb-acc" accounts={accounts} value={acc} onChange={setAcc} nullable />
            <label className="field__label" id="sb-seg">Segmented control</label>
            <SegmentedControl label="Demo" value={seg} onChange={setSeg} options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }, { value: 'c', label: 'Three' }]} />
            <Checkbox label="Checkbox" checked={chk} onChange={(e) => setChk(e.target.checked)} />
          </div>
        </Panel>
        <Panel title="Badges, priority, overlays">
          <div className="sandbox__row">
            {['Not Started', 'In Progress', 'Waiting', 'Complete', 'Exception', 'Failed', 'Passed'].map((s) => <StatusBadge key={s} value={s} />)}
          </div>
          <div className="sandbox__row"><PriorityLabel value="High" /><PriorityLabel value="Medium" /><PriorityLabel value="Low" /></div>
          <div className="sandbox__row">
            <Button icon={<Plus size={16} strokeWidth={1.5} />} onClick={() => setDlg(true)}>Open dialog</Button>
            <Button onClick={() => toast.push({ kind: 'success', message: 'Saved', detail: 'Success toast' })}>Success toast</Button>
            <Button onClick={() => toast.push({ kind: 'error', message: 'Could not save', detail: 'Errors stay until dismissed' })}>Error toast</Button>
          </div>
        </Panel>
        <Panel title="Instruments (Run 2)">
          <div className="sandbox__row"><StackBar meter={{ open: 12, overdue: 3, waiting: 2, other: 7 }} /></div>
          <div className="sandbox__row"><Sparkline values={[32, 35, 30, 34, 48, 52, 60]} label="CPU, last 7d, latest 60" tone="warning" /></div>
          <div className="sandbox__row"><ProgressRing done={3} total={8} /><span className="num">3 of 8 tasks done</span></div>
          <div className="sandbox__row"><DotRow dots={[{ tone: null }, { tone: 'warning' }, { tone: null }]} label="3 servers, 1 with an alert" /><Avatar name="Sofia Whitcombe" /><DatePill pill={{ date: '13 Oct', rel: '', overdue: false, today: true }} /></div>
        </Panel>
      </div>
      {dlg && (
        <Dialog title="Sample dialog" width={440} onClose={() => setDlg(false)} footer={<><Button onClick={() => setDlg(false)}>Cancel</Button><Button variant="primary" onClick={() => setDlg(false)}>OK</Button></>}>
          <p>Focus is trapped here. Escape closes. Focus returns to the button that opened it.</p>
        </Dialog>
      )}
    </div>
  );
}

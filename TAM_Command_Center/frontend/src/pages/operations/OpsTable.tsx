import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { accountPath } from '../../lib/links';
import { groupIds, summaryText, triState, type Tri } from '../../lib/operations';
import type { OpsGroup, OpsRow } from '../../opsTypes';
import { statusOptions } from './ApplianceEditDialog';

export function TriCheck({ state, label, onChange }: { state: Tri; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return (
    <label className="check ops-cb" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" className="check__input" checked={state === 'all'} aria-checked={state === 'some' ? 'mixed' : state === 'all'} onChange={onChange} aria-label={label} />
      <span className="check__box" aria-hidden="true">{state === 'some' ? <span className="ops-cb__dash" /> : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m5 12 5 5 9-10" /></svg>}</span>
    </label>
  );
}

function DateCell({ r }: { r: OpsRow }) {
  if (!r.date.effective) {
    return <span className="ops-notset">Not set{r.date.reason && <span className="muted sm ops-reason">{r.date.reason}</span>}</span>;
  }
  return (
    <span className="ops-datecell">
      <span className="num">{r.date.effective}</span>
      {r.date.source === 'override' && <span className="ops-ovr" title="Date override" role="img" aria-label="Date override" />}
      {r.overdue && <span className="badge badge--danger">Overdue</span>}
    </span>
  );
}

function VersionCell({ r }: { r: OpsRow }) {
  const v = r.version;
  if (!v.effective) return <span className="ops-notset">Not set</span>;
  if (v.source === 'appliance') return <span className="num">{v.effective}<span className="ops-ovr" title="This appliance's own version" role="img" aria-label="Own version" /></span>;
  return <span className="ops-dflt">default <span className="num">{v.effective}</span></span>;
}

export function EnvCell({ r }: { r: OpsRow }) {
  if (!r.environment) return <span className="ops-notset">Environment not set</span>;
  if (r.environment === 'DEV') return <span>DEV</span>;
  return <span>PROD &middot; {r.polarity ?? <span className="ops-notset">East/West not set</span>}</span>;
}

export function OpsTable({ groups, selecting, allOpen, onToggleAll, selected, isOpen, onToggleOpen, onToggleGroup, onToggleRow, onStatus, onEdit }: {
  groups: OpsGroup[]; selecting: boolean; allOpen: boolean; onToggleAll: () => void; selected: ReadonlySet<string>; isOpen: (clientId: string) => boolean;
  onToggleOpen: (clientId: string) => void; onToggleGroup: (g: OpsGroup) => void; onToggleRow: (id: string) => void;
  onStatus: (r: OpsRow, status: string) => void; onEdit: (r: OpsRow) => void;
}) {
  return (
    <div className="panel table-scroll ops-tablewrap">
      <table className="table ops-table">
        <caption className="sr-only">Appliance upgrades grouped by account</caption>
        <thead>
          <tr>
            <th className="ops-col-cb" scope="col">
              <button type="button" className="ops-chev" aria-expanded={allOpen} aria-label={allOpen ? 'Collapse all accounts' : 'Expand all accounts'} title={allOpen ? 'Collapse all accounts' : 'Expand all accounts'} onClick={onToggleAll}>
                {allOpen ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
              </button>
            </th>
            <th scope="col">Date</th><th scope="col">Appliance</th><th scope="col">Env / Polarity</th><th scope="col">Target version</th><th scope="col">Status</th><th scope="col">Note</th>
            <th scope="col"><span className="sr-only">Edit</span></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const open = isOpen(g.client_id);
            const tri = triState(groupIds(g), selected);
            return (
              <GroupRows key={g.client_id} selecting={selecting} g={g} open={open} tri={tri} selected={selected} onToggleOpen={onToggleOpen} onToggleGroup={onToggleGroup} onToggleRow={onToggleRow} onStatus={onStatus} onEdit={onEdit} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ selecting, g, open, tri, selected, onToggleOpen, onToggleGroup, onToggleRow, onStatus, onEdit }: {
  selecting: boolean; g: OpsGroup; open: boolean; tri: Tri; selected: ReadonlySet<string>;
  onToggleOpen: (id: string) => void; onToggleGroup: (g: OpsGroup) => void; onToggleRow: (id: string) => void; onStatus: (r: OpsRow, s: string) => void; onEdit: (r: OpsRow) => void;
}) {
  return (
    <>
      <tr className="ops-acct" onClick={() => onToggleOpen(g.client_id)}>
        <td colSpan={8}>
          <div className="ops-ah">
            <button type="button" className="ops-chev" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.client_name}`} onClick={(e) => { e.stopPropagation(); onToggleOpen(g.client_id); }}>
              {open ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
            </button>
            {selecting && <TriCheck state={tri} label={`Select all ${g.client_name}`} onChange={() => onToggleGroup(g)} />}
            <Link to={accountPath(g.client_id)} className="ops-acctlink" onClick={(e) => e.stopPropagation()}>{g.client_name}</Link>
            <span className="muted sm">{summaryText(g.count, g.summary)}</span>
          </div>
        </td>
      </tr>
      {open && g.rows.map((r) => (
        <tr key={r.object_id} className={selected.has(r.object_id) ? 'ops-row is-sel' : 'ops-row'}>
          <td className="ops-col-cb">{selecting && <TriCheck state={selected.has(r.object_id) ? 'all' : 'none'} label={`Select ${r.appliance}`} onChange={() => onToggleRow(r.object_id)} />}</td>
          <td className="ops-pl"><DateCell r={r} /></td>
          <td>{r.appliance}{!r.enabled && <span className="muted sm"> disabled</span>}</td>
          <td><EnvCell r={r} /></td>
          <td><VersionCell r={r} /></td>
          <td>
            <span className="ops-status">
              <Select size="sm" value={r.status} onChange={(v) => v && v !== r.status && onStatus(r, v)} options={statusOptions(r.status)} aria-label={`Status for ${r.appliance}`} className="ops-statussel" />
              {r.status_is_default && <span className="sr-only"> (default)</span>}
            </span>
          </td>
          <td className="muted ops-note" title={r.notes ?? undefined}>{r.notes ? <span className="truncate">{r.notes}</span> : ''}</td>
          <td><Button size="sm" variant="icon" aria-label={`Edit ${r.appliance}`} title="Edit" onClick={() => onEdit(r)} icon={<Pencil size={14} strokeWidth={1.5} />} /></td>
        </tr>
      ))}
    </>
  );
}


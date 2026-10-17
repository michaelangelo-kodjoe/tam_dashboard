import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/** Header chevron: expands all groups when any is collapsed, otherwise collapses all. Shared by Operations and BAMS. */
export function ToggleAllButton({ allOpen, onToggle, noun = 'accounts' }: { allOpen: boolean; onToggle: () => void; noun?: string }) {
  const label = `${allOpen ? 'Collapse' : 'Expand'} all ${noun}`;
  return (
    <button type="button" className="ops-chev" aria-expanded={allOpen} aria-label={label} title={label} onClick={onToggle}>
      {allOpen ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

/** One collapsible group row (chevron button with aria-expanded, optional lead such as a checkbox, name, summary). The whole row toggles. */
export function GroupHeaderRow({ colSpan, open, onToggle, name, nameNode, summary, lead }: {
  colSpan: number; open: boolean; onToggle: () => void; name: string; nameNode?: ReactNode; summary: string; lead?: ReactNode;
}) {
  return (
    <tr className="ops-acct" onClick={onToggle}>
      <td colSpan={colSpan}>
        <div className="ops-ah">
          <button type="button" className="ops-chev" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            {open ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
          </button>
          {lead}
          {nameNode ?? <b className="ops-acctlink">{name}</b>}
          <span className="muted sm">{summary}</span>
        </div>
      </td>
    </tr>
  );
}

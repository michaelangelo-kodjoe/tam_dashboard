import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { QueueItem } from '../../types';
import type { TimeDisplay } from '../../lib/dates';
import { TIER_TONE, groupByTier, itemKey, rowWhen, type Show } from '../../lib/triage';
import { cx } from '../../lib/cx';
import { Check } from 'lucide-react';
import { useApp } from '../../store/DataContext';
import { Button } from '../../components/ui/Button';
import { useCompleteTask } from '../../components/tasks/useCompleteTask';
import { TerminalLinkText } from '../../components/ui/TerminalLinkText';

export const optionId = (i: number) => `triage-opt-${i}`;

/** Elements that own the arrow/Enter keys; the page-level handler must stay out of their way. */
const OWNS_KEYS = 'input, textarea, select, button, a, [role="tab"], [role="radio"], [role="combobox"], [role="menuitem"], [contenteditable="true"]';

export function TriageList({ items, total, show, selected, onSelect, onOpen, onViewAll, today, tz }: {
  items: QueueItem[];
  total: number;
  show: Show;
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (item: QueueItem) => void;
  onViewAll: () => void;
  today: string;
  tz: TimeDisplay;
}) {
  const { state } = useApp();
  /** One-line task notes preview (first non-empty line); null for other kinds. */
  const rowNotes = (i: QueueItem): string | null => {
    if (i.kind !== 'task') return null;
    const n = state.tasks.find((t) => t.id === i.id)?.notes;
    return n ? n.split('\n').find((l) => l.trim())?.trim() ?? null : null;
  };
  const completeTask = useCompleteTask();
  const [doneBusy, setDoneBusy] = useState<string | null>(null);
  const markDone = async (i: QueueItem) => {
    const t = state.tasks.find((x) => x.id === i.id);
    if (!t || t.status === 'Complete' || doneBusy) return;
    setDoneBusy(i.id);
    try { await completeTask(t); } finally { setDoneBusy(null); }
  };
  const ref = useRef<HTMLDivElement>(null);

  const handle = (key: string): boolean => {
    if (items.length === 0) return false;
    if (key === 'ArrowDown') onSelect(Math.min(items.length - 1, selected + 1));
    else if (key === 'ArrowUp') onSelect(Math.max(0, selected - 1));
    else if (key === 'Home') onSelect(0);
    else if (key === 'End') onSelect(items.length - 1);
    else if (key === 'Enter') { if (items[selected]) onOpen(items[selected]); }
    else return false;
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (handle(e.key)) e.preventDefault();
  };

  // Arrow keys work without first clicking the list, unless a control or dialog owns the keyboard.
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t === ref.current || ref.current?.contains(t))) return; // the listbox handles its own keys
      const onChip = !!t?.closest?.('[role="radio"]');
      if (t && t.closest?.(OWNS_KEYS) && !(onChip && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) return; // Left/Right belong to the chips
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (latest.current(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    document.getElementById(optionId(selected))?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  const renderRow = (i: QueueItem, idx: number) => {
    const when = rowWhen(i, today, tz);
    const tone = i.tier != null ? TIER_TONE[i.tier] : 'neutral';
    return (
      <div
        key={itemKey(i)}
        id={optionId(idx)}
        role="option"
        aria-selected={idx === selected}
        className={cx('trow', idx === selected && 'is-selected')}
        onClick={() => onSelect(idx)}
        onDoubleClick={() => onOpen(i)}
      >
        <span className="trow__n num" aria-hidden="true">{idx + 1}</span>
        <span className={`trow__bar tier--${tone}`} aria-hidden="true" />
        <span className="trow__text">
          <b className="truncate" title={i.title}>{i.title}</b>
          <small className="truncate">{i.client_name ?? 'No account'}</small>
          {rowNotes(i) && <small className="truncate trow__note"><TerminalLinkText text={rowNotes(i)} /></small>}
        </span>
        {i.kind === 'task'
          ? <Button variant="ghost" size="sm" className="trow__done" busy={doneBusy === i.id} aria-label={`Mark done: ${i.title}`} title="Mark done" icon={<Check size={14} strokeWidth={1.5} />}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); void markDone(i); }} onDoubleClick={(e) => e.stopPropagation()}>Done</Button>
          : <span className="trow__done-spacer" aria-hidden="true" />}
        <span className={cx('trow__when num', `when--${when.tone}`)}>{when.text}</span>
      </div>
    );
  };

  const grouped = show === 'all' ? groupByTier(items) : null;

  return (
    <section className="panel triage__list" aria-label="Work queue">
      <div
        ref={ref}
        className="triage__box"
        role="listbox"
        tabIndex={0}
        aria-label="Work queue, most important first"
        aria-activedescendant={items.length ? optionId(selected) : undefined}
        onKeyDown={onKeyDown}
      >
        {grouped
          ? grouped.map((g) => (
              <div key={g.tier} role="group" aria-label={`${g.label}, ${g.items.length} items`}>
                <h3 className="tier-head label" aria-hidden="true">{g.label} <span className="num">({g.items.length})</span></h3>
                {g.items.map((it, k) => <Fragment key={itemKey(it)}>{renderRow(it, g.start - 1 + k)}</Fragment>)}
              </div>
            ))
          : items.map(renderRow)}
      </div>
      <div className="triage__foot">
        <span className="num">Showing {items.length} of {show === 'top' ? total : items.length}</span>
        {show === 'top' && total > items.length && (
          <Link to="?show=all" className="more-link" onClick={(e) => { e.preventDefault(); onViewAll(); }}>View all ({total}) &rsaquo;</Link>
        )}
      </div>
    </section>
  );
}

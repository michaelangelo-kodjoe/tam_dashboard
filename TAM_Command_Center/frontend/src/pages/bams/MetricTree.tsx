import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import type { BamsRow, Severity } from '../../bamsTypes';
import { buildMetricTree, isAccountOpen, loadMasterOpen, saveMasterOpen } from '../../lib/bamsTree';
import { formatValue } from '../../lib/bams';
import { cx } from '../../lib/cx';

const DOT: Record<Severity, string> = { Critical: 'bm-dot--critical', Warning: 'bm-dot--warning', Info: 'bm-dot--info' };
function Dot({ sev }: { sev: Severity | null }) {
  return <span className={cx('bm-dot', sev ? DOT[sev] : 'bm-dot--ok')} title={sev ?? 'No active alert'}><span className="sr-only">{sev ? `${sev} alert` : 'No active alert'}</span></span>;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Left-hand metric list for Alert configuration (mockup 08, revised): accounts at the top level, appliances
 * and their metrics nested inside. One master chevron opens or closes every account group; the filter sits in
 * the same row. Collapsed by default; the master state is remembered in localStorage until changed.
 */
export function MetricTree({ rows, selectedId, linkedId, onSelect }: { rows: BamsRow[]; selectedId: string | null; /** metric the page was opened on by link; its account starts open until the user toggles something */ linkedId?: string | null; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const [master, setMaster] = useState(loadMasterOpen);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [closedAppl, setClosedAppl] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildMetricTree(rows, filter), [rows, filter]);
  const filtering = filter.trim() !== '';
  const [linkedAccount, setLinkedAccount] = useState<string | null>(() => rows.find((r) => r.id === linkedId)?.object.client_id ?? null);
  const open = (id: string) => isAccountOpen(id, { master, overrides, filtering, selectedAccountId: linkedAccount });
  const allOpen = tree.length > 0 && tree.every((a) => open(a.id));

  const toggleMaster = () => { const next = !allOpen; setLinkedAccount(null); setMaster(next); setOverrides({}); saveMasterOpen(next); };
  const toggleAccount = (id: string) => setOverrides((o) => ({ ...o, [id]: !open(id) }));
  const toggleAppl = (id: string) => setClosedAppl((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="bm-tree">
      <div className="bm-tree__master">
        <button type="button" className="btn btn--ghost btn--sm bm-tree__mbtn" aria-expanded={allOpen} aria-label={allOpen ? 'Collapse all account groups' : 'Expand all account groups'} title="Expand / collapse all" onClick={toggleMaster}>
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className="bm-chev" />
        </button>
        <span className="label">Metrics</span>
        <label className="bm-search bm-tree__filter"><Search size={14} strokeWidth={1.5} aria-hidden="true" /><input className="bm-search__input" type="search" aria-label="Filter metrics" placeholder="Filter metrics" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      </div>
      <div className="bm-metricnav" role="tree" aria-label="Metrics by account">
        {tree.map((a) => {
          const isOpen = open(a.id);
          return (
            <div key={a.id} className="bm-tg" role="treeitem" aria-expanded={isOpen}>
              <button type="button" className="bm-tg__head" aria-expanded={isOpen} aria-controls={`bm-tg-${a.id}`} onClick={() => toggleAccount(a.id)}>
                <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className="bm-chev" />
                <b className="truncate">{a.name}</b>
                <Dot sev={a.worst} />
                <span className="bm-tg__cnt num">{plural(a.count, 'metric')}</span>
              </button>
              {isOpen && (
                <div id={`bm-tg-${a.id}`} role="group">
                  {a.appliances.map((o) => {
                    const oOpen = filtering || !closedAppl.has(o.id);
                    return (
                      <div key={o.id} className="bm-ta">
                        <button type="button" className="bm-ta__head" aria-expanded={oOpen} onClick={() => toggleAppl(o.id)}>
                          <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" className="bm-chev" />
                          <span className="mono truncate">{o.name}</span>
                          <Dot sev={o.worst} />
                          <span className="bm-tg__cnt num">{plural(o.rows.length, 'metric')}</span>
                        </button>
                        {oOpen && o.rows.map((r) => (
                          <button key={r.id} type="button" role="treeitem" aria-selected={r.id === selectedId} aria-current={r.id === selectedId ? 'true' : undefined} className={cx('bm-metricnav__item bm-tm', r.id === selectedId && 'is-on')} onClick={() => onSelect(r.id)}>
                            <Dot sev={r.alert && r.alert.status !== 'closed' ? r.alert.severity : null} />
                            <span className="bm-metricnav__name truncate">{r.metric_name}</span>
                            <span className="bm-tm__v num">{r.current_value == null ? '' : formatValue(r.current_value)}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {tree.length === 0 && <p className="muted sm bm-metricnav__none">No metric matches.</p>}
      </div>
    </div>
  );
}

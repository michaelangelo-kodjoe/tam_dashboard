import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FileText, Phone, Plus, Search, UsersRound } from 'lucide-react';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { SplitButton } from '../../components/ui/Menu';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorBanner, SkeletonRows, StaleDataBanner } from '../../components/ui/Feedback';
import { Timeline } from '../../components/activity/Timeline';
import { useApp, useData, useQuery } from '../../store/DataContext';
import type { AccountSummary, ActivityEntry, ActivityFilter, NoteType } from '../../types';
import { useDebounced } from '../../lib/hooks';
import { formatTimestamp } from '../../lib/dates';

const FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'meeting', label: 'Meeting notes' },
  { value: 'call', label: 'Call notes' },
  { value: 'general', label: 'General' },
  { value: 'system', label: 'System events' },
];
const NOTE_MENU: { id: NoteType; label: string; icon: JSX.Element }[] = [
  { id: 'Meeting Note', label: 'Meeting note', icon: <UsersRound size={16} strokeWidth={1.5} /> },
  { id: 'Call Note', label: 'Call note', icon: <Phone size={16} strokeWidth={1.5} /> },
  { id: 'General Note', label: 'General note', icon: <FileText size={16} strokeWidth={1.5} /> },
];

export function ActivityTab({ account }: { account: AccountSummary }) {
  const { today, settings } = useApp();
  const loc = useLocation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [text, setText] = useState('');
  const q = useDebounced(text, 250);
  const first = useQuery(`activity:${account.id}:${filter}:${q}`, (ds) => ds.getActivity(account.id, { filter, q, limit: 50 }));
  const [extra, setExtra] = useState<{ stamp: number; items: ActivityEntry[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const stamp = first.lastOk?.getTime() ?? 0;
  const { ds } = useData();

  useEffect(() => { setExtra(null); setMoreError(null); }, [filter, q, stamp]);

  const entries = [...(first.data?.items ?? []), ...(extra && extra.stamp === stamp ? extra.items : [])];
  const cursor = extra && extra.stamp === stamp ? extra.cursor : first.data?.next_cursor ?? null;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await ds.getActivity(account.id, { filter, q, cursor, limit: 50 });
      setExtra((e) => ({ stamp, items: [...(e && e.stamp === stamp ? e.items : []), ...page.items], cursor: page.next_cursor }));
    } catch (err) {
      setMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const newNote = (type: NoteType) => {
    const p = new URLSearchParams(loc.search);
    p.set('note', 'new');
    p.set('type', type);
    navigate(`${loc.pathname}?${p.toString()}`);
  };

  return (
    <div className="activity">
      <div className="filterbar" role="search" aria-label="Activity filters">
        <SegmentedControl<ActivityFilter> label="Activity filter" size="sm" value={filter} onChange={setFilter} options={FILTERS} />
        <div className="filterbar__item filterbar__item--search">
          <Search size={16} strokeWidth={1.5} className="filterbar__icon" aria-hidden="true" />
          <input type="search" className="input input--sm filterbar__search" placeholder="Search subject and body" aria-label="Search activity" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="filterbar__spacer" />
        <SplitButton label="Note" icon={<Plus size={16} strokeWidth={1.5} />} menuLabel="Choose note type" items={NOTE_MENU} onPrimary={() => newNote('Meeting Note')} onSelect={(id) => newNote(id as NoteType)} />
      </div>
      {first.stale && <StaleDataBanner since={first.lastOk ? formatTimestamp(first.lastOk.toISOString(), settings.time_display).slice(7) : 'earlier'} onRetry={first.reload} />}
      {first.error ? <ErrorBanner error={first.error} onRetry={first.reload} title="Could not load activity" /> : null}
      {first.loading && <SkeletonRows rows={6} label="Loading activity" />}
      {first.data && entries.length === 0 && (
        <EmptyState action={<Button size="sm" variant="primary" onClick={() => newNote('Meeting Note')}>+ Note</Button>}>
          {q || filter !== 'all' ? 'No activity matches these filters.' : 'No activity for this account yet.'}
        </EmptyState>
      )}
      {entries.length > 0 && <Timeline entries={entries} clientId={account.id} tz={settings.time_display} today={today} />}
      {moreError ? <ErrorBanner error={moreError} onRetry={() => void loadMore()} title="Could not load more" /> : null}
      {cursor && (
        <div className="activity__more">
          <Button onClick={() => void loadMore()} busy={loadingMore} busyLabel="Loading…">Load more</Button>
        </div>
      )}
    </div>
  );
}


import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { QueueItem } from '../../types';
import { TIER_TONE, openLabel, whySentence } from '../../lib/triage';
import { queueTarget } from '../../lib/links';
import { formatDate, relativeLabel } from '../../lib/dates';
import { useApp } from '../../store/DataContext';

/** D-34: highest-ranked queue item (tiers 1-5) for this account. Read-only: why it is here and a link. */
export function TopItem({ item }: { item: QueueItem }) {
  const { today } = useApp();
  const tone = item.tier != null ? TIER_TONE[item.tier] : 'neutral';
  const rel = item.days_delta != null ? relativeLabel(item.days_delta).text : '';
  const meta = [item.priority && `${item.priority} priority`, item.severity, item.kind !== 'client_follow_up' ? item.status : null, item.date && item.date_kind !== 'opened' ? formatDate(item.date.slice(0, 10), today) : null]
    .filter(Boolean).join(' · ');
  return (
    <article className={`topitem tier--${tone}`} aria-label="Top item for this account">
      <div className={`label topitem__cap topitem__cap--${tone}`}>Top item for this account{rel ? ` · ${rel}` : ''}</div>
      <h2 className="topitem__title">{item.title}</h2>
      {meta && <div className="muted">{meta}</div>}
      <p className="topitem__why">{whySentence(item, today)}</p>
      <div className="topitem__foot">
        <Link to={queueTarget(item)} className="btn btn--primary btn--md">
          <span className="btn__label">{openLabel(item)}</span>
          <span className="btn__icon" aria-hidden="true"><ArrowRight size={14} strokeWidth={1.5} /></span>
        </Link>
      </div>
    </article>
  );
}

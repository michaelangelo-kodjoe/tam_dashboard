import { Link } from 'react-router-dom';
import { AlarmClock, ArrowRight, ArrowUpCircle, CalendarClock, ListChecks, Siren, type LucideIcon } from 'lucide-react';
import type { QueueItem } from '../../types';
import type { TimeDisplay } from '../../lib/dates';
import { TIER_TONE, keyFacts, openLabel, whySentence } from '../../lib/triage';
import { accountPath, queueTarget } from '../../lib/links';
import { useApp } from '../../store/DataContext';
import { RichText } from '../../components/ui/Feedback';
import { PriorityLabel, SeverityBadge, StatusBadge } from '../../components/ui/Badges';

const KIND_ICON: Record<QueueItem['kind'], LucideIcon> = {
  task: ListChecks, client_follow_up: CalendarClock, bams_alert: Siren, server_upgrade: ArrowUpCircle,
};

/** One badge at most (guidelines §4). */
function HeaderBadge({ item }: { item: QueueItem }) {
  if (item.kind === 'bams_alert' && item.severity) return <SeverityBadge severity={item.severity} status={item.status} />;
  if (item.kind === 'task') return <PriorityLabel value={item.priority} />;
  if (item.kind === 'server_upgrade') return <StatusBadge value={item.status} />;
  return null;
}

/** Why it is here, key facts, one Open link. Nothing here completes or edits the item (D-28). */
export function TriageDetail({ item, today, tz }: { item: QueueItem; today: string; tz: TimeDisplay }) {
  const { state } = useApp();
  const notes = item.kind === 'task' ? state.tasks.find((t) => t.id === item.id)?.notes ?? null : null;
  const tone = item.tier != null ? TIER_TONE[item.tier] : 'neutral';
  const Icon = item.urgency === 'overdue' && item.kind === 'task' ? AlarmClock : KIND_ICON[item.kind];
  const facts = keyFacts(item, today, tz);
  return (
    <section className="panel triage__detail" aria-label="Selected item">
      <header className={`detail__head tier--${tone}`}>
        <div className="detail__kind">
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="label">{item.type_label}{item.tier_label ? ` · ${item.tier_label}` : ''}</span>
          <span className="detail__spacer" />
          <HeaderBadge item={item} />
        </div>
        <h2 className="detail__title">{item.title}</h2>
        <p className="detail__acct">
          {item.client_id ? <Link className="acct-link muted" to={accountPath(item.client_id)}>{item.client_name}</Link> : <span className="subtle">No account</span>}
        </p>
      </header>
      <div className="detail__cols">
        <div className="detail__col">
          <h3 className="label">Notes</h3>
          {item.kind === 'task'
            ? (notes ? <RichText text={notes} className="detail__notes-body" /> : <p className="subtle detail__why">No notes</p>)
            : <p className="detail__why">{whySentence(item, today)}</p>}
        </div>
        <div className="detail__col">
          <h3 className="label">Key facts</h3>
          <dl className="facts">
            {facts.map((f) => (
              <div className="fact" key={f.label}>
                <dt className="muted">{f.label}</dt>
                <dd className="num">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <footer className="detail__foot">
        <Link to={queueTarget(item)} className="btn btn--primary btn--md">
          <span className="btn__label">{openLabel(item)}</span>
          <span className="btn__icon" aria-hidden="true"><ArrowRight size={14} strokeWidth={1.5} /></span>
        </Link>
        <span className="detail__spacer" />
        <span className="muted sm">Up/Down moves · Enter opens</span>
      </footer>
    </section>
  );
}

import { Link } from 'react-router-dom';
import { Activity, MessagesSquare, ServerCog, type LucideIcon } from 'lucide-react';
import { PageHeader, Panel } from '../components/ui/Panel';
import { useDocumentTitle } from '../lib/hooks';

const CONTENT: Record<'operations' | 'bams' | 'bridge', { title: string; icon: LucideIcon; text: string; links: { to: string; label: string }[] }> = {
  operations: {
    title: 'Operations',
    icon: ServerCog,
    text: 'The quarterly server upgrade workbench: the maintenance calendar, the working queue of upgrades that need attention, schedule sync with diagnostics, and bulk upload. Upgrade records already show on each account\'s Infrastructure tab.',
    links: [{ to: '/accounts', label: 'Open an account to see its upgrade records' }, { to: '/today', label: 'Near-term upgrades appear in the Today work queue' }],
  },
  bams: {
    title: 'BAMS',
    icon: Activity,
    text: 'Infrastructure monitoring: metrics, alert rules, the alert lifecycle (open, recovered, closed), freshness and notifications. Seeded monitored appliances and alerts already show on each account\'s Infrastructure tab and in Today.',
    links: [{ to: '/accounts', label: 'Open an account to see its monitored appliances' }, { to: '/today', label: 'Active alerts appear in the Today work queue' }],
  },
  bridge: {
    title: 'ChatGPT Bridge',
    icon: MessagesSquare,
    text: 'Copy an account\'s context out, paste a structured update back, preview it, then apply it. Nothing is written until you apply.',
    links: [{ to: '/accounts', label: 'Browse accounts' }],
  },
};

export function PlaceholderPage({ kind }: { kind: keyof typeof CONTENT }) {
  const c = CONTENT[kind];
  const Icon = c.icon;
  useDocumentTitle(c.title);
  return (
    <div className="page">
      <PageHeader title={<span className="placeholder__title"><Icon size={20} strokeWidth={1.5} aria-hidden="true" /> {c.title}</span>} />
      <Panel title="Not built yet" className="placeholder">
        <p>{c.text}</p>
        <p className="muted placeholder__later">Planned for a later release. Nothing on this page can be used yet.</p>
        <ul className="placeholder__links">
          {c.links.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
        </ul>
      </Panel>
    </div>
  );
}

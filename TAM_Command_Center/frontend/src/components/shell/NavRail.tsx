import { NavLink } from 'react-router-dom';
import { Activity, Building2, CalendarCheck, ListChecks, MessagesSquare, ServerCog, Settings, type LucideIcon } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { useMediaQuery } from '../../lib/hooks';
import { cx } from '../../lib/cx';

interface Item { to: string; label: string; icon: LucideIcon; later?: boolean }

const MAIN: Item[] = [
  { to: '/today', label: 'Today', icon: CalendarCheck },
  { to: '/accounts', label: 'Accounts', icon: Building2 },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/operations', label: 'Operations', icon: ServerCog, later: true },
  { to: '/bams', label: 'BAMS', icon: Activity, later: true },
  { to: '/bridge', label: 'ChatGPT Bridge', icon: MessagesSquare, later: true },
];
const FOOT: Item[] = [{ to: '/settings', label: 'Settings', icon: Settings }];

export function NavRail() {
  const collapsed = useMediaQuery('(max-width: 1279px)');
  const render = (it: Item) => {
    const Icon = it.icon;
    const link = (
      <NavLink
        key={it.to}
        to={it.to}
        aria-label={collapsed ? (it.later ? `${it.label} (later release)` : it.label) : undefined}
        className={({ isActive }) => cx('rail__item', isActive && 'is-active')}
      >
        <Icon size={18} strokeWidth={1.5} aria-hidden="true" className="rail__icon" />
        <span className="rail__label">{it.label}</span>
        {it.later && <span className="rail__later">Later</span>}
      </NavLink>
    );
    return (
      <li key={it.to}>
        <Tooltip text={it.later ? `${it.label} · later release` : it.label} placement="right" disabled={!collapsed}>
          {link}
        </Tooltip>
      </li>
    );
  };
  return (
    <nav aria-label="Primary" className="rail">
      <div className="rail__brand" aria-label="TAM Command Center">
        <span className="rail__logo" aria-hidden="true" />
        <span className="rail__name">TAM CC</span>
      </div>
      <ul className="rail__list">{MAIN.map(render)}</ul>
      <ul className="rail__list rail__list--foot">{FOOT.map(render)}</ul>
    </nav>
  );
}

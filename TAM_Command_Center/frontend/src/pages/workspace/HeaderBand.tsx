import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { StatusBadge } from '../../components/ui/Badges';
import { DotRow, MeterLegend, ProximityTrack, StackBar, type InstrumentTone } from '../../components/ui/Instruments';
import type { AccountSummary, Infrastructure, QueueItem } from '../../types';
import { diffDays, formatDate, relativeLabel } from '../../lib/dates';
import { meterOf, openUpgradeCount, proximityPct, serverSummary, worstAlert } from '../../lib/instruments';
import { accountPath } from '../../lib/links';
import { useApp } from '../../store/DataContext';
import { cx } from '../../lib/cx';

function Cell({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('metric', className)}>
      <div className="label">{caption}</div>
      {children}
    </div>
  );
}

function DateValue({ date, today, overdueTone }: { date: string | null; today: string; overdueTone?: boolean }) {
  if (!date) return <div className="metric__v subtle">-</div>;
  const rel = relativeLabel(diffDays(date, today));
  return (
    <div className="metric__v num">
      {formatDate(date, today)}
      <small className={cx(overdueTone && rel.overdue && 'danger-text', rel.today && 'accent-text')}>{rel.text}</small>
    </div>
  );
}

/** Account header band (guidelines §15.1): name row, then metric cells with at most one instrument each. */
export function HeaderBand({ account, infra, queue, editLink }: { account: AccountSummary; infra: Infrastructure | null; queue: QueueItem[] | null; editLink: string }) {
  const { state, today } = useApp();
  const tasks = state.tasks.filter((t) => t.client_id === account.id);
  const meter = meterOf(tasks, today);
  const tiles = infra?.servers ?? [];
  const sum = serverSummary(tiles);
  const dots = tiles.map((t) => ({
    name: t.name,
    tone: (t.alert_severity === 'Critical' ? 'danger' : t.alert_severity === 'Warning' ? 'warning' : null) as InstrumentTone | null,
  }));
  const withAlert = sum.warning + sum.critical;
  const envText = infra ? ([sum.prod ? `PROD ${sum.prod}` : '', sum.dev ? `DEV ${sum.dev}` : '', sum.unknown ? `+${sum.unknown} unknown` : ''].filter(Boolean).join(' · ') || '') : (state.infrastructure[account.id]?.env_summary ?? '');
  const alert = queue ? worstAlert(queue, account.id) : null;
  const next = state.infrastructure[account.id]?.next_upgrade ?? null;
  const primary = state.contacts.find((c) => c.client_id === account.id && c.is_primary);
  const products = (account.products ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const nextTouchRel = account.next_contact ? relativeLabel(diffDays(account.next_contact, today)).text : '';

  return (
    <header className="wsband">
      <div className="wsband__top">
        <div className="wsband__id">
          <div className="wsband__row">
            <h1 className="wshead__name">{account.name}</h1>
            {account.status === 'Inactive' && <StatusBadge value="Inactive" />}
          </div>
          <div className="wsband__tags">
            {account.bpid && <span className="mono muted sm">BPID {account.bpid}</span>}
            {products.map((p) => <span key={p} className="tag-plain">{p}</span>)}
          </div>
        </div>
        <div className="pagehead__spacer" />
        <Link to={editLink} className="btn btn--secondary btn--sm">
          <span className="btn__icon" aria-hidden="true"><Pencil size={16} strokeWidth={1.5} /></span>
          <span className="btn__label">Edit account</span>
        </Link>
      </div>
      <div className="wsband__cells" role="group" aria-label="Account counts">
        <Cell caption="Open tasks">
          <div className="metric__v num">
            {account.open_tasks}
            <small><span className={account.overdue > 0 ? 'danger-text' : 'subtle'}>{account.overdue} overdue</span> · {account.waiting} waiting</small>
          </div>
          <StackBar meter={meter} />
          <MeterLegend meter={meter} />
        </Cell>
        <Cell caption="Servers">
          <div className="metric__v num">{account.servers}<small>{envText}</small></div>
          {infra ? <DotRow dots={dots} square label={`${tiles.length} ${tiles.length === 1 ? 'server' : 'servers'}, ${withAlert} with an alert`} /> : <span className="subtle sm">Loading</span>}
          <p className="legend">
            {sum.critical > 0 && <span className="danger-text">{sum.critical} critical</span>}
            {sum.warning > 0 && <span className="warning-text">{sum.warning} {sum.warning === 1 ? 'warning' : 'warnings'}</span>}
            {infra && withAlert === 0 && <span className="subtle">No server alerts</span>}
          </p>
        </Cell>
        <Cell caption="Alerts">
          <div className={cx('metric__v num', account.active_alerts > 0 ? 'warning-text' : 'subtle')}>{account.active_alerts}</div>
          <p className="legend metric__alert truncate" title={alert ? (alert.context ?? alert.title) : undefined}>
            {alert ? <span>{alert.context ?? alert.title}</span> : <span className="subtle">{account.active_alerts > 0 ? '' : 'None open'}</span>}
          </p>
        </Cell>
        <Cell caption="Next upgrade">
          <DateValue date={next?.date ?? null} today={today} overdueTone />
          {next && <ProximityTrack pct={proximityPct(next.date, today)} tone="info" label={`${relativeLabel(diffDays(next.date, today)).text}, on a 30 day scale`} />}
          <p className="legend">
            {next && <Link className="mono" to={accountPath(account.id, 'infrastructure', { server: next.server })}>{next.server}</Link>}
            {infra && <span>{openUpgradeCount(infra.upgrades)} open {openUpgradeCount(infra.upgrades) === 1 ? 'upgrade' : 'upgrades'}</span>}
          </p>
        </Cell>
        <Cell caption="Next client touch">
          <DateValue date={account.next_contact} today={today} overdueTone />
          {account.next_contact && <ProximityTrack pct={proximityPct(account.next_contact, today)} tone="accent" label={`${nextTouchRel}, on a 30 day scale`} />}
          <p className="legend">
            {primary && <span>{primary.name}</span>}
            <span>{account.last_contact ? `last ${formatDate(account.last_contact, today)}` : 'no contact recorded'}</span>
          </p>
        </Cell>
      </div>
    </header>
  );
}

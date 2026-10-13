import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Star } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Avatar } from '../../components/ui/Instruments';
import { DateField } from '../../components/ui/Fields';
import { RichText } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { useApp, useData } from '../../store/DataContext';
import type { AccountSummary } from '../../types';
import { accountPath } from '../../lib/links';
import { diffDays, formatDate, relativeLabel, agoLabel } from '../../lib/dates';
import { cx } from '../../lib/cx';

/** One continuous surface with internal dividers (spec §10; guidelines §2). */
export function ContextRail({ account }: { account: AccountSummary }) {
  const { state, today } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const loc = useLocation();
  const infra = state.infrastructure[account.id];
  const contacts = state.contacts
    .filter((c) => c.client_id === account.id)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.name.localeCompare(b.name));
  const primary = contacts.find((c) => c.is_primary);
  const touchRef = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState<string | null>(account.next_contact);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loc.hash === '#next-touch') touchRef.current?.focus();
  }, [loc.hash, account.id]);

  const rel = account.next_contact ? relativeLabel(diffDays(account.next_contact, today)) : null;

  const saveDate = async () => {
    setBusy(true);
    try {
      await ds.saveAccount({
        id: account.id, name: account.name, bpid: account.bpid, products: account.products, status: account.status,
        next_contact: date, notes: account.notes, expected_row_version: account.row_version,
      });
      bump();
      toast.push({ kind: 'success', message: date ? `Next client touch set to ${formatDate(date, today)}` : 'Next client touch cleared' });
      setEditing(false);
    } catch (e) {
      toast.push({ kind: 'error', message: 'Could not save the date.', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="rail-ctx" aria-label="Account brief">
      <section id="next-touch" ref={touchRef} tabIndex={-1} className="rail-ctx__sec" aria-labelledby="rc-touch">
        <h2 id="rc-touch" className="label">Next client touch</h2>
        {!editing ? (
          <>
            {account.next_contact ? (
              <p className="rc-big num">
                {formatDate(account.next_contact, today)}
                <span className={cx('rc-rel', rel?.overdue && 'danger-text')}> · {rel?.text}</span>
              </p>
            ) : (
              <p className="muted">No date set.</p>
            )}
            {primary && <p className="muted">with {primary.name}</p>}
            <div className="rc-row">
              <Button size="sm" onClick={() => { setDate(account.next_contact); setEditing(true); }}>{account.next_contact ? 'Set date' : 'Set date'}</Button>
            </div>
          </>
        ) : (
          <div className="rc-edit">
            <DateField value={date} onChange={setDate} today={today} ariaLabel="Next client touch date" />
            <div className="rc-row">
              <Button size="sm" variant="primary" busy={busy} onClick={() => void saveDate()}>Save date</Button>
              <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            </div>
          </div>
        )}
        <p className="muted rc-small">
          Last contact{' '}
          {account.last_contact ? (
            <span className="num">{formatDate(account.last_contact, today)} · {agoLabel(diffDays(account.last_contact, today))}</span>
          ) : (
            'none recorded'
          )}
        </p>
      </section>

      <section className="rail-ctx__sec" aria-labelledby="rc-infra">
        <h2 id="rc-infra" className="label">Infrastructure</h2>
        <dl className="rc-dl">
          <dt>Servers</dt><dd className="num">{infra?.servers ?? 0}</dd>
          <dt>Active alerts</dt><dd className={cx('num', (infra?.active_alerts ?? 0) > 0 && 'warning-text')}>{infra?.active_alerts ?? 0}</dd>
          <dt>Next upgrade</dt>
          <dd className="num">
            {infra?.next_upgrade ? (
              <Link to={accountPath(account.id, 'infrastructure', { server: infra.next_upgrade.server })}>
                {formatDate(infra.next_upgrade.date, today)} <span className="mono">{infra.next_upgrade.server}</span>
              </Link>
            ) : (
              <span className="subtle">-</span>
            )}
          </dd>
          <dt>Environments</dt><dd>{infra?.env_summary || <span className="subtle">-</span>}</dd>
          <dt>Regions</dt><dd>{infra?.regions.length ? infra.regions.join(', ') : <span className="subtle">-</span>}</dd>
        </dl>
      </section>

      <section className="rail-ctx__sec" aria-labelledby="rc-contacts">
        <div className="rc-head">
          <h2 id="rc-contacts" className="label">Contacts</h2>
          <Link className="more-link" to={accountPath(account.id, 'contacts')}>All ({contacts.length})</Link>
        </div>
        {contacts.length === 0 ? (
          <p className="muted">No contacts yet.</p>
        ) : (
          <ul className="rc-contacts">
            {contacts.slice(0, 5).map((c) => (
              <li key={c.id} className="rc-contact">
                <Avatar name={c.name} />
                <div className="rc-contact__body">
                <p className="rc-contact__name">
                  {c.is_primary && <Star size={14} strokeWidth={1.5} fill="currentColor" className="accent-text" aria-hidden="true" />}
                  <span>{c.name}</span>
                  {c.is_primary && <span className="tag tag--accent">Primary</span>}
                </p>
                <p className="muted rc-small">{[c.role, c.team].filter(Boolean).join(' · ') || <span className="subtle">No role</span>}</p>
                {c.email && <p className="rc-small"><a href={`mailto:${c.email}`}>{c.email}</a></p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rail-ctx__sec" aria-labelledby="rc-details">
        <h2 id="rc-details" className="label">Account details</h2>
        <dl className="rc-dl">
          <dt>BPID</dt><dd className="mono">{account.bpid ?? <span className="subtle">-</span>}</dd>
          <dt>Products</dt><dd>{account.products ?? <span className="subtle">-</span>}</dd>
        </dl>
        {account.notes ? <RichText text={account.notes} className="rc-notes" /> : <p className="muted rc-small">No account notes.</p>}
      </section>
    </aside>
  );
}

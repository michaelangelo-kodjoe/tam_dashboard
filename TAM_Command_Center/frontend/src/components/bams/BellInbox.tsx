import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Bell, CheckCircle2, Info } from 'lucide-react';
import { Button } from '../ui/Button';
import { useApp, useData, useQuery } from '../../store/DataContext';
import { formatStamp, formatTime } from '../../lib/bams';
import { parseInstant } from '../../lib/dates';
import { cx } from '../../lib/cx';

const POLL_MS = 15_000;
/** Time of day for today, otherwise "12 Oct". */
function when(instant: string, tz: 'local' | 'gmt'): string {
  return parseInstant(instant).toDateString() === new Date().toDateString() ? formatTime(instant, tz) : formatStamp(instant, tz).replace(/ \d{1,2}:\d\d( [AP]M)?$/, '');
}

/** Bell with an unread count and the in-app inbox popover (mockup 07). Hidden quietly when BAMS notifications are unavailable. */
export function BellInbox() {
  const { settings } = useApp();
  const { ds } = useData();
  const navigate = useNavigate();
  const q = useQuery('bams-notifications', (d) => d.getBamsNotifications(30), { refreshMs: POLL_MS });
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    const onDown = (e: MouseEvent) => { const n = e.target as Node; if (!pop.current?.contains(n) && !btn.current?.contains(n)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    pop.current?.querySelector<HTMLElement>('button, a')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  if (!q.data) return null;
  const unread = q.data.unread_count;
  const markAll = async () => { await ds.markBamsNotificationsRead({ all: true }); q.reload(); };
  const go = async (n: (typeof q.data.items)[number]) => {
    setOpen(false);
    if (n.unread) { await ds.markBamsNotificationsRead({ through_id: n.id }); q.reload(); }
    navigate(`/bams/alerts?event=${encodeURIComponent(n.event_id)}`);
  };

  return (
    <div className="bm-bell">
      <button ref={btn} type="button" className="bm-bell__btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        <Bell size={16} strokeWidth={1.5} aria-hidden="true" />
        {unread > 0 && <span className="bm-bell__n num" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div ref={pop} id={id} role="dialog" aria-label="Notifications" className="bm-pop">
          <div className="bm-pop__head">
            <b>Notifications</b>
            {unread > 0 && <span className="badge badge--danger">{unread} unread</span>}
            <span className="bm-bar__spacer" />
            <Button size="sm" variant="ghost" disabled={unread === 0} onClick={() => void markAll()}>Mark all read</Button>
          </div>
          <ul className="bm-pop__list">
            {q.data.items.length === 0 && <li className="bm-pop__none muted">No notifications yet.</li>}
            {q.data.items.map((n) => (
              <li key={n.id}>
                <button type="button" className={cx('bm-nt', n.unread && 'is-unread')} onClick={() => void go(n)}>
                  {n.kind === 'opened' ? <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true" className={n.severity === 'Warning' ? 'bm-warning' : n.severity === 'Info' ? 'bm-info' : 'bm-danger'} /> : n.kind === 'recovered' ? <CheckCircle2 size={16} strokeWidth={1.5} aria-hidden="true" className="bm-warning" /> : <Info size={16} strokeWidth={1.5} aria-hidden="true" className="muted" />}
                  <span className="bm-nt__body"><span>{n.title}</span><span className="muted sm">{n.detail}</span></span>
                  <span className="muted sm num">{when(n.attempted_at, settings.time_display)}</span>
                  {n.unread && <span className="sr-only">(unread)</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="bm-pop__foot"><Button size="sm" onClick={() => { setOpen(false); navigate('/bams/alerts'); }}>Open Alerts view</Button></div>
        </div>
      )}
    </div>
  );
}

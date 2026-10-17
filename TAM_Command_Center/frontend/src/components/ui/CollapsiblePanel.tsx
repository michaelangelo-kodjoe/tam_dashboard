import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cx } from '../../lib/cx';

const KEY = 'tam.panel.';
function read(id: string): boolean {
  try { return sessionStorage.getItem(KEY + id) === '1'; } catch { return false; }
}
function write(id: string, open: boolean): void {
  try { sessionStorage.setItem(KEY + id, open ? '1' : '0'); } catch { /* not remembered */ }
}

/**
 * Panel whose body is hidden until the header (a real button with aria-expanded) is opened.
 * Collapsed by default; the open state is remembered for the browser session only (sessionStorage).
 * `children` is a render function so a section can skip loading its data while collapsed.
 */
export function CollapsiblePanel({ id, title, hint, className, forceOpen, children }: {
  id: string; title: ReactNode; hint?: ReactNode; className?: string; /** open on mount (deep link, e.g. ?section=audit) */ forceOpen?: boolean; children: (open: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(() => !!forceOpen || read(id));
  const bodyId = useId();
  const toggle = () => setOpen((o) => { write(id, !o); return !o; });
  return (
    <section className={cx('panel', 'cpanel', open && 'is-open', className)}>
      <h2 className="cpanel__h">
        <button type="button" className="cpanel__btn" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          {open ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
          <span className="label cpanel__title">{title}</span>
          {hint && <span className="muted sm cpanel__hint">{hint}</span>}
        </button>
      </h2>
      <div id={bodyId} role="region" aria-label={typeof title === 'string' ? title : undefined} hidden={!open} className="cpanel__body">
        {open && children(open)}
      </div>
    </section>
  );
}

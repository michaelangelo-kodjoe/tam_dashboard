import { TerminalLinkText } from './TerminalLinkText';
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from './Button';
import { cx } from '../../lib/cx';
import { DataSourceError } from '../../data/DataSource';

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="muted">{children}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, title = 'Could not load this data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const code = error instanceof DataSourceError ? error.code : 'internal';
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="banner banner--danger">
      <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" />
      <div className="banner__body">
        <p className="banner__title">{title}</p>
        <p className="muted">{message}</p>
        <details className="banner__details">
          <summary>Details</summary>
          <span className="mono">code: {code}</span>
        </details>
      </div>
      {onRetry && <Button size="sm" onClick={onRetry} icon={<RefreshCw size={14} strokeWidth={1.5} />}>Retry</Button>}
    </div>
  );
}

/** Earlier data is still shown but the latest refresh failed (guidelines §12). */
export function StaleDataBanner({ since, onRetry }: { since: string; onRetry?: () => void }) {
  return (
    <div role="status" className="banner banner--warning">
      <WifiOff size={16} strokeWidth={1.5} aria-hidden="true" />
      <div className="banner__body">
        <p>Showing data from {since}. Reconnecting…</p>
      </div>
      {onRetry && <Button size="sm" onClick={onRetry}>Retry now</Button>}
    </div>
  );
}

/** Shown only after 300ms to avoid flicker (guidelines §12). */
export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setShow(true), 300);
    return () => clearTimeout(h);
  }, []);
  return (
    <div aria-busy="true" aria-live="polite" className={cx('skeleton', !show && 'is-hidden')}>
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton__row" style={{ width: `${92 - ((i * 13) % 35)}%` }} />
      ))}
    </div>
  );
}

/** The single render path for user text (D-16): escaped plain text, line breaks preserved, {commands} become Bloomberg Terminal links. */
export function RichText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return <div className={cx('richtext', className)}><TerminalLinkText text={text} /></div>;
}

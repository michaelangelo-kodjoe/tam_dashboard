import type { ReactNode } from 'react';
import { DataSourceError } from '../../data/DataSource';
import { cx } from '../../lib/cx';

export const REFRESH_MS = 15_000;

/** One-line message for toasts and inline errors. */
export function errText(e: unknown, fallback = 'Something went wrong. Nothing was changed.'): string {
  if (e instanceof DataSourceError) {
    if (e.code === 'network') return e.message;
    return e.message || fallback;
  }
  return fallback;
}

export function Kpi({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: 'danger' | 'warning' | 'success'; sub?: ReactNode }) {
  return (
    <div className="bm-kpi">
      <span className="label">{label}</span>
      <span className={cx('bm-kpi__v num', tone && `bm-${tone}`)}>{value}</span>
      <span className="muted sm">{sub}</span>
    </div>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

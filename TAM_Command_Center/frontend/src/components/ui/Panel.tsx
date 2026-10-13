import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

/** `--surface-1` panel with a 12/16 header (guidelines §2). Never nested inside another panel. */
export function Panel({ title, count, actions, children, className, bodyClassName, as = 'section', id, labelledBy }: {
  title?: ReactNode;
  count?: number | null;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: 'section' | 'div' | 'aside';
  id?: string;
  labelledBy?: string;
}) {
  const Tag = as;
  const hid = id ? `${id}-h` : undefined;
  return (
    <Tag className={cx('panel', className)} id={id} aria-labelledby={title ? (labelledBy ?? hid) : undefined}>
      {(title || actions) && (
        <header className="panel__head">
          <h2 className="panel__title label" id={hid}>
            {title}
            {count != null && <span className="panel__count num"> ({count})</span>}
          </h2>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={cx('panel__body', bodyClassName)}>{children}</div>
    </Tag>
  );
}

export function PageHeader({ title, meta, actions, children }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <div className="pagehead__row">
        <h1 className="pagehead__title">{title}</h1>
        {meta && <div className="pagehead__meta muted">{meta}</div>}
        <div className="pagehead__spacer" />
        {actions && <div className="pagehead__actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

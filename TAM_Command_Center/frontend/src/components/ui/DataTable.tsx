import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { cx } from '../../lib/cx';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** comparator; presence makes the column sortable */
  sort?: (a: T, b: T) => number;
  align?: 'left' | 'right';
  /** tabular numerals */
  num?: boolean;
  mono?: boolean;
  /** this cell holds the real link/button used for keyboard row activation */
  primary?: boolean;
  width?: number | string;
  /** visually hide the header text (action columns) */
  hideHeader?: boolean;
  className?: string;
}

export interface SortState { key: string; dir: 'asc' | 'desc' }

export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Real <a> in the primary cell (supports middle-click) and whole-row click */
  rowHref?: (row: T) => string;
  /** Primary cell becomes a button; whole row clickable */
  onRowOpen?: (row: T) => void;
  highlight?: (row: T) => boolean;
  rowClassName?: (row: T) => string | undefined;
  sort?: SortState | null;
  onSortChange?: (s: SortState | null) => void;
  defaultSort?: SortState | null;
  density?: 'compact' | 'comfortable';
  empty?: ReactNode;
  /** cap height so the sticky header works against the viewport */
  fill?: boolean;
  /** show a chevron column (row navigation) */
  chevron?: boolean;
  /** id of the element holding a visible heading (otherwise caption is sr-only) */
  className?: string;
}

/** Native table; sticky header; sortable headers (aria-sort); whole-row navigation with a real link in the primary cell. */
export function DataTable<T>({
  caption, columns, rows, rowKey, rowHref, onRowOpen, highlight, rowClassName, sort: sortProp, onSortChange, defaultSort = null,
  density = 'compact', empty, fill, chevron, className,
}: DataTableProps<T>) {
  const [inner, setInner] = useState<SortState | null>(defaultSort);
  const sort = sortProp !== undefined ? sortProp : inner;
  const navigate = useNavigate();
  const setSort = (s: SortState | null) => (onSortChange ? onSortChange(s) : setInner(s));

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const f = col.sort;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.map((r, i) => ({ r, i })).sort((a, b) => f(a.r, b.r) * dir || a.i - b.i).map((x) => x.r);
  }, [rows, columns, sort]);

  const clickHeader = (c: Column<T>) => {
    if (!c.sort) return;
    if (!sort || sort.key !== c.key) setSort({ key: c.key, dir: 'asc' });
    else if (sort.dir === 'asc') setSort({ key: c.key, dir: 'desc' });
    else setSort(null);
  };

  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    const t = e.target as HTMLElement;
    if (t.closest('a, button, input, select, textarea, [role="combobox"], [role="checkbox"], [role="radio"]')) return;
    if (rowHref) navigate(rowHref(row));
    else onRowOpen?.(row);
  };
  const interactive = !!(rowHref || onRowOpen);
  const colSpan = columns.length + (chevron ? 1 : 0);

  return (
    <div className={cx('table-scroll', fill && 'table-scroll--fill', className)}>
      <table className={cx('table', `table--${density}`)}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const isSorted = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sort ? (isSorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  className={cx(c.align === 'right' && 'is-right', c.hideHeader && 'is-action')}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.sort ? (
                    <button type="button" className="th-btn" onClick={() => clickHeader(c)}>
                      <span>{c.header}</span>
                      <span className="th-btn__sort" aria-hidden="true">
                        {isSorted ? (sort!.dir === 'asc' ? <ArrowUp size={12} strokeWidth={1.5} /> : <ArrowDown size={12} strokeWidth={1.5} />) : null}
                      </span>
                    </button>
                  ) : c.hideHeader ? (
                    <span className="sr-only">{c.header}</span>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {chevron && <th scope="col" className="is-chev"><span className="sr-only">Open</span></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr className="table__empty">
              <td colSpan={colSpan}>{empty ?? <span className="muted">Nothing to show.</span>}</td>
            </tr>
          )}
          {sorted.map((row) => {
            const k = rowKey(row);
            return (
              <tr
                key={k}
                className={cx(interactive && 'is-clickable', highlight?.(row) && 'is-highlight', rowClassName?.(row))}
                data-row-key={k}
                onClick={interactive ? (e) => onRowClick(e, row) : undefined}
              >
                {columns.map((c) => {
                  const content = c.cell(row);
                  let node: ReactNode = content;
                  if (c.primary && rowHref) node = <Link className="row-link" to={rowHref(row)}>{content}</Link>;
                  else if (c.primary && onRowOpen) node = <button type="button" className="row-link" onClick={() => onRowOpen(row)}>{content}</button>;
                  return (
                    <td key={c.key} className={cx(c.align === 'right' && 'is-right', (c.num || c.align === 'right') && 'num', c.mono && 'mono', c.primary && 'is-primary', c.className)}>
                      {node}
                    </td>
                  );
                })}
                {chevron && (
                  <td className="is-chev" aria-hidden="true">
                    <ChevronRight size={16} strokeWidth={1.5} className="row-chev" />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Comparator helpers: nulls always last regardless of direction is NOT possible with a
 * flipped sign, so nulls sort as "greatest" and appear last in ascending order. */
export const cmpStr = (a: string | null | undefined, b: string | null | undefined) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base' });
export const cmpNum = (a: number | null | undefined, b: number | null | undefined) =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b;

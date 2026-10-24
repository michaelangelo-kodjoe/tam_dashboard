import type { Upgrade30 } from '../../types';
import { buildColumns, markerTone, shortDate } from '../../lib/upgradeTimeline';

const ROW_H = 16;

/** Overview timeline: one coloured marker per date and polarity, no appliance names. Scales with the panel; close dates stagger. */
export function UpgradeTimeline({ items, today }: { items: Upgrade30[]; today: string }) {
  const cols = buildColumns(items, today);
  if (cols.length === 0) return <p className="subtle sm utl__empty">No Upgrades In The Next 30 Days</p>;
  const rows = Math.max(...cols.map((c) => c.row)) + 1;
  const axisTop = rows * ROW_H + 8;
  return (
    <div className="utl">
      <ol className="utl__track" aria-label="Upgrades, Next 30 Days" style={{ height: axisTop + 20 }}>
        <li className="utl__axis" style={{ top: axisTop }} aria-hidden="true" />
        {cols.map((c) => {
          const edge = c.pct < 8 ? 'start' : c.pct > 92 ? 'end' : 'mid';
          return (
            <li key={c.date} className={`utl__col utl__col--${edge}`} style={{ left: `${c.pct}%`, top: 0 }}>
              <span className="utl__date" style={{ top: c.row * ROW_H }}>{shortDate(c.date)}</span>
              <span className="utl__mks" style={{ top: axisTop - 7 }}>
                {c.markers.map((m) => <span key={m.key} className={`utl__mk utl__mk--${markerTone(m.polarity)}`} role="img" tabIndex={0} title={m.label} aria-label={m.label} />)}
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="utl__lg" aria-label="Legend">
        <li><i className="utl__mk utl__mk--west" aria-hidden="true" />West</li>
        <li><i className="utl__mk utl__mk--east" aria-hidden="true" />East</li>
        <li><i className="utl__mk utl__mk--dev" aria-hidden="true" />DEV</li>
      </ul>
    </div>
  );
}

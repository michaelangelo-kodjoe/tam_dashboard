import type { ServerTile } from '../../types';
import { Sparkline } from '../../components/ui/Instruments';
import { shortMetric, sparkWindowLabel } from '../../lib/instruments';
import { cx } from '../../lib/cx';

function Tile({ t }: { t: ServerTile }) {
  const sev = t.alert_severity;
  const dot = sev === 'Critical' ? 'danger' : sev === 'Warning' ? 'warning' : 'muted';
  const state = sev === 'Critical' ? 'Critical alert' : sev === 'Warning' ? 'Warning alert' : sev === 'Info' ? 'Info alert' : 'healthy';
  const tone = sev === 'Critical' ? 'danger' : sev === 'Warning' ? 'warning' : 'neutral';
  const s = t.spark;
  const values = s ? s.points.map((p) => p[1]) : [];
  const metric = s ? shortMetric(s.metric) : '';
  const win = s ? sparkWindowLabel(s.window_hours) : '';
  const latest = values.length ? values[values.length - 1] : null;
  return (
    <li className={cx('srvtile', sev === 'Critical' && 'srvtile--danger', sev === 'Warning' && 'srvtile--warning')}>
      <div className="srvtile__name mono"><i className={`status-dot status-dot--${dot}`} aria-hidden="true" /><span className="truncate" title={t.name}>{t.name}</span></div>
      <div className="srvtile__meta muted">
        {[t.environment, t.version ? `v${t.version}` : null].filter(Boolean).join(' · ') || 'No version'}
        {' · '}<span className={cx(sev === 'Critical' && 'danger-text', sev === 'Warning' && 'warning-text')}>{state}</span>
      </div>
      {s && values.length >= 2 ? (
        <>
          <Sparkline values={values} tone={tone} label={`${metric}, last ${win}, latest ${latest}`} />
          <div className="srvtile__cap muted">{metric} {win}{latest != null ? ` · latest ${latest}` : ''}</div>
        </>
      ) : (
        <div className="srvtile__cap subtle">No trend data</div>
      )}
    </li>
  );
}

export function ServerTiles({ tiles }: { tiles: ServerTile[] }) {
  if (tiles.length === 0) return <p className="subtle sm srv-empty">No servers recorded for this account.</p>;
  return <ul className="srvgrid" aria-label="Servers">{tiles.map((t) => <Tile key={t.name} t={t} />)}</ul>;
}

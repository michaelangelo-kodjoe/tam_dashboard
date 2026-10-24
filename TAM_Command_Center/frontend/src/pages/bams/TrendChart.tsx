import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RotateCcw } from 'lucide-react';
import type { BamsTrend, Operator } from '../../bamsTypes';
import { Button } from '../../components/ui/Button';
import { formatPlain } from '../../lib/bams';
import { formatTimestamp } from '../../lib/dates';
import { bandOf, dragToWindow, minWindowMs, severityLevels, severitySegments, tickLabel, timeTicks, windowLabel, type Band, type Window } from '../../lib/chartZoom';

const TOP = 10;
const BOTTOM = 24;
const AXIS_W = 48; // YAxis width
const RIGHT = 8;
const COLOR: Record<Band, string> = { n: 'var(--info)', w: 'var(--warning)', c: 'var(--danger)' };
const BAND_NAME: Record<Band, string> = { n: 'Normal', w: 'Warning', c: 'Critical' };

/**
 * Trend line coloured by severity (normal below Warning, amber at Warning, red at Critical) with
 * click-drag zoom. No reference lines: the colour carries the thresholds (mockups 01-03).
 */
export interface WindowFetch { data: BamsTrend | null; loading: boolean; error: unknown }

export function TrendChart({ trend, rules = [], height = 220, onZoom, windowFetch }: {
  trend: BamsTrend; rules?: { id: string; operator: Operator }[]; height?: number;
  /** called when a zoom commits (window) or is reset (null); the owner fetches finer data for the window */
  onZoom?: (w: Window | null) => void;
  /** the fetched samples for the current zoom window; the client-side zoom shows until they arrive */
  windowFetch?: WindowFetch;
}) {
  const full = useMemo<Window | null>(() => {
    const ts = trend.points.map((p) => Date.parse(p.t));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : null;
  }, [trend]);
  const [zoom, setZoom] = useState<Window | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setZoom(null); setDrag(null); }, [trend.metric_id, trend.range]);
  const commit = (w: Window | null) => { setZoom(w); onZoom?.(w); };
  const fine = zoom && windowFetch?.data && windowFetch.data.points.length > 0 ? windowFetch.data : null;
  const emptyWindow = !!zoom && !!windowFetch?.data && !windowFetch.loading && windowFetch.data.points.length === 0;
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setDrag(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag]);

  const levels = useMemo(() => severityLevels(trend.rule_lines, rules), [trend, rules]);
  const view: Window | null = zoom ?? full;
  const rows = useMemo(() => {
    if (!full) return [];
    const [lo, hi] = view!;
    // keep one point either side of the window so the line reaches the edges
    const pts = (fine ?? trend).points.map((p) => ({ ts: Date.parse(p.t), v: p.v }));
    const first = pts.findIndex((p) => p.ts >= lo);
    const last = pts.length - 1 - [...pts].reverse().findIndex((p) => p.ts <= hi);
    const slice = pts.slice(Math.max(0, first - 1), Math.min(pts.length, last + 2));
    const seg = severitySegments(slice.map((p) => p.v), levels);
    return slice.map((p, i) => ({ ts: p.ts, v: p.v, n: seg.n[i], w: seg.w[i], c: seg.c[i] }));
  }, [trend, fine, view, full, levels]);
  const [ylo, yhi] = useMemo(() => {
    const vals = rows.filter((r) => r.ts >= view![0] && r.ts <= view![1]).map((r) => r.v);
    if (!vals.length) return [0, 100];
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    const pad = (mx - mn || 1) * 0.08;
    return [Math.floor((mn - pad) * 10) / 10, Math.ceil((mx + pad) * 10) / 10];
  }, [rows, view]);

  if (!full || !view) return <div className="bm-chart bm-chart--empty muted">No values stored for this range.</div>;

  const plot = () => { const r = box.current?.getBoundingClientRect(); return r ? { left: r.left + AXIS_W, w: r.width - AXIS_W - RIGHT } : null; };
  const rel = (e: { clientX: number }) => { const p = plot(); return p ? Math.max(0, Math.min(p.w, e.clientX - p.left)) : 0; };
  const onDown = (e: RPointerEvent) => {
    const p = plot();
    if (e.button !== 0 || !p || e.clientX < p.left || e.clientX > p.left + p.w) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const x = rel(e);
    setDrag({ x0: x, x1: x });
  };
  const onMove = (e: RPointerEvent) => { if (drag) setDrag({ ...drag, x1: rel(e) }); };
  const onUp = (e: RPointerEvent) => {
    if (!drag) return;
    const p = plot();
    const w = p ? dragToWindow(drag.x0, rel(e), p.w, view, full, { minMs: minWindowMs(fine?.sample_interval_seconds) }) : null;
    setDrag(null);
    if (w) commit(w);
  };
  const zoomed = zoom != null;
  const dragLabel = drag && plot() ? (() => {
    const w = dragToWindow(drag.x0, drag.x1, plot()!.w, view, full, { minMs: minWindowMs(fine?.sample_interval_seconds) });
    return w ? windowLabel(w, full).replace(/^Zoomed: /, '') : null;
  })() : null;
  const span = view[1] - view[0];
  const present = (['n', 'w', 'c'] as Band[]).filter((b) => b === 'n' || levels[b === 'w' ? 'warn' : 'crit']);

  return (
    <div className="bm-chartwrap">
      <div className="bm-rangebar">
        <span className={`bm-rangelabel${zoomed ? ' is-zoomed' : ''}`} aria-live="polite">{windowLabel(view, full)}</span>
        <Button size="sm" disabled={!zoomed} onClick={() => commit(null)} icon={<RotateCcw size={14} strokeWidth={1.5} />}>Reset zoom</Button>
        <span className="muted sm bm-rangehint">{zoomed ? 'Double-click or Reset zoom to go back.' : 'Drag on the chart to zoom (up to 7 days).'}</span>
        {zoomed && windowFetch?.loading && <span className="muted sm" role="status">Loading finer data…</span>}
      </div>
      {zoomed && !!windowFetch?.error && !windowFetch.loading && (
        <div className="banner banner--warning bm-zoomnote" role="alert"><div className="banner__body">{windowError(windowFetch.error)} Showing the zoomed view of the loaded data.</div><Button size="sm" onClick={() => commit(null)}>Reset zoom</Button></div>
      )}
      {emptyWindow && (
        <div className="banner banner--info bm-zoomnote" role="status"><div className="banner__body">No samples in this window.</div><Button size="sm" onClick={() => commit(null)}>Reset zoom</Button></div>
      )}
      {zoomed && windowFetch?.data?.downsampled && <p className="muted sm bm-rangehint">This window holds more than 2,000 samples, so points are thinned evenly. Zoom in further for every sample.</p>}
      <div
        className="bm-chart bm-chart--zoom" ref={box} role="img" aria-label={`Trend chart, ${trend.points.length} points. ${windowLabel(view, full)}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} onDoubleClick={() => commit(null)}
      >
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={rows} margin={{ top: TOP, right: RIGHT, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="ts" type="number" ticks={timeTicks(view[0], view[1])} scale="time" domain={view} allowDataOverflow tickFormatter={(t: number) => tickLabel(t, span)} stroke="var(--border-strong)" tick={{ fill: 'var(--muted)', fontSize: 11 }} height={BOTTOM + 6} />
            <YAxis domain={[ylo, yhi]} width={AXIS_W} allowDataOverflow tickFormatter={(v: number) => `${formatPlain(v)}%`} stroke="var(--border-strong)" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
            <Tooltip content={<TrendTip levels={levels} />} />
            {(['n', 'w', 'c'] as Band[]).map((b) => (
              <Line key={b} type="linear" dataKey={b} name={BAND_NAME[b]} stroke={COLOR[b]} strokeWidth={b === 'n' ? 1.6 : 2} dot={false} activeDot={false} isAnimationActive={false} connectNulls={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {drag && (
          <div className="bm-sel" style={{ left: AXIS_W + Math.min(drag.x0, drag.x1), width: Math.abs(drag.x1 - drag.x0), top: TOP, bottom: BOTTOM + 6 }} aria-hidden="true">
            {dragLabel && <span>{dragLabel}</span>}
          </div>
        )}
      </div>
      <div className="bm-legend">
        {present.map((b) => <span key={b}><i style={{ background: COLOR[b] }} />{b === 'n' ? (levels.warn || levels.crit ? 'Normal (below Warning)' : 'Value') : b === 'w' ? `Warning reached (${levels.warn!.below ? '<=' : '>='} ${formatPlain(levels.warn!.value)})` : `Critical reached (${levels.crit!.below ? '<=' : '>='} ${formatPlain(levels.crit!.value)})`}</span>)}
      </div>
    </div>
  );
}

/** One value per point (the coloured series share their joining points, so the default tooltip would repeat it). */
function TrendTip({ active, payload, levels }: { active?: boolean; payload?: { payload?: { ts: number; v: number } }[]; levels: ReturnType<typeof severityLevels> }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="bm-tip">
      <div className="muted">{formatTimestamp(new Date(row.ts).toISOString(), 'local', '1970-01-01')}</div>
      <div><b className="num">{row.v.toFixed(1)}%</b> <span className="muted">{BAND_NAME[bandOf(row.v, levels)]}</span></div>
    </div>
  );
}

function windowError(e: unknown): string {
  const f = e && typeof e === 'object' && 'fields' in e ? (e as { fields?: Record<string, string> }).fields : undefined;
  const first = f ? Object.values(f)[0] : undefined;
  return first ? `That window cannot be loaded: ${first}` : e instanceof Error && e.message ? e.message : 'Could not load that window.';
}

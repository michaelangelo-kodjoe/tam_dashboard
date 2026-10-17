import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BamsTrend, Severity } from '../../bamsTypes';
import { formatPlain } from '../../lib/bams';
import { formatTimestamp, timeOfDay } from '../../lib/dates';

const H = 220;
const TOP = 10;
const BOTTOM = 24;

/** Push labels apart so no two are closer than `gap` px (mockup 03 amendment: no overlapping reference labels). */
export function spreadLabels(ys: number[], gap = 13): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = new Array<number>(ys.length);
  let prev = -Infinity;
  for (const o of order) {
    const y = Math.max(o.y, prev + gap);
    out[o.i] = y;
    prev = y;
  }
  return out;
}

const sevColor = (s: Severity) => (s === 'Critical' ? 'var(--danger)' : s === 'Warning' ? 'var(--warning)' : 'var(--info)');

function tick(ts: number, range: string): string {
  const d = new Date(ts);
  return range === '24h' ? timeOfDay(d) : `${d.getDate()}/${d.getMonth() + 1}`;
}

/** One tick per distinct label (first occurrence), so date labels never repeat. */
export function uniqueTicks(ts: number[], range: string, max = 7): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const t of ts) {
    const l = tick(t, range);
    if (!seen.has(l)) { seen.add(l); out.push(t); }
  }
  const step = Math.ceil(out.length / max);
  return step > 1 ? out.filter((_, i) => i % step === 0) : out;
}

/** Recharts line + 30/60/90 day highs and rule thresholds. Colours come from tokens via CSS variables. */
export function TrendChart({ trend }: { trend: BamsTrend }) {
  const data = useMemo(() => trend.points.map((p) => ({ ts: Date.parse(p.t), v: p.v })), [trend]);
  const lines = useMemo(() => {
    const refs = trend.reference_lines.filter((l) => l.value != null).map((l) => ({ key: l.id, label: `${l.label} ${formatPlain(l.value!)}%`, value: l.value!, color: 'var(--muted)', dash: '2 3' }));
    const rules = trend.rule_lines.map((l) => ({ key: l.rule_id, label: `${l.label}%`, value: l.value, color: sevColor(l.severity), dash: '5 3' }));
    return [...refs, ...rules];
  }, [trend]);
  const [lo, hi] = useMemo(() => {
    const vals = [...data.map((d) => d.v), ...lines.map((l) => l.value)];
    if (!vals.length) return [0, 100];
    const mn = Math.min(...vals); const mx = Math.max(...vals);
    const pad = (mx - mn || 1) * 0.08;
    return [Math.floor((mn - pad) * 10) / 10, Math.ceil((mx + pad) * 10) / 10];
  }, [data, lines]);
  const plotH = H - TOP - BOTTOM;
  const yOf = (v: number) => TOP + ((hi - v) / (hi - lo || 1)) * plotH;
  const dys = spreadLabels(lines.map((l) => yOf(l.value))).map((y, i) => y - yOf(lines[i].value));

  if (data.length === 0) return <div className="bm-chart bm-chart--empty muted">No values stored for this range.</div>;
  return (
    <div className="bm-chart" role="img" aria-label={`Trend chart, ${data.length} points`}>
      <ResponsiveContainer width="100%" height={H}>
        <LineChart data={data} margin={{ top: TOP, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="ts" type="number" ticks={uniqueTicks(data.map((d) => d.ts), trend.range)} scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => tick(t, trend.range)} stroke="var(--border-strong)" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <YAxis domain={[lo, hi]} width={48} allowDataOverflow tickFormatter={(v: number) => `${formatPlain(v)}%`} stroke="var(--border-strong)" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: 4, fontSize: 12 }}
            labelStyle={{ color: 'var(--muted)' }}
            itemStyle={{ color: 'var(--text)' }}
            labelFormatter={(t) => formatTimestamp(new Date(Number(t)).toISOString(), 'local', '1970-01-01')}
            formatter={(v) => [`${Number(v).toFixed(1)}%`, 'Value']}
          />
          {lines.map((l, i) => (
            <ReferenceLine key={l.key} y={l.value} stroke={l.color} strokeDasharray={l.dash} strokeWidth={1}
              label={{ value: l.label, position: 'insideTopRight', fill: l.color, fontSize: 10, dy: dys[i] - 8 }} ifOverflow="extendDomain" />
          ))}
          <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BamsTrend } from '../../bamsTypes';
import { TrendChart } from './TrendChart';

beforeAll(() => {
  // jsdom has no PointerEvent: give testing-library a constructor that carries clientX
  if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class extends MouseEvent {} as typeof MouseEvent;
});
afterEach(() => cleanup());

const T0 = Date.UTC(2026, 9, 14, 0, 0);
const trend = (rules = true): BamsTrend => ({
  metric_id: 'm1', range: '24h', from: new Date(T0).toISOString(), to: new Date(T0 + 1439 * 60_000).toISOString(),
  points: Array.from({ length: 288 }, (_, i) => ({ t: new Date(T0 + i * 5 * 60_000).toISOString(), v: 50 + 45 * Math.sin(i / 20) })),
  downsampled: false, text: { min: 5, max: 95, last: 60, count: 288, from: null, to: null },
  reference_lines: [{ id: 'high_30', label: '30D high', value: 97, date: '2026-10-01' }],
  rule_lines: rules ? [{ rule_id: 'w', label: 'Warning threshold 75', value: 75, severity: 'Warning' }, { rule_id: 'c', label: 'Critical threshold 90', value: 90, severity: 'Critical' }] : [],
});
function chart(el: HTMLElement) {
  const box = el.querySelector('.bm-chart--zoom') as HTMLElement;
  box.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1056, bottom: 220, width: 1056, height: 220, x: 0, y: 0, toJSON: () => ({}) });
  return box;
}

describe('TrendChart (items 1 to 3)', () => {
  it('drops the 30/60/90 day highs and threshold lines; severity shows in the legend as text', () => {
    const { container } = render(<TrendChart trend={trend()} rules={[{ id: 'w', operator: '>' }, { id: 'c', operator: '>' }]} />);
    expect(container.textContent).not.toMatch(/30D high|60D high|90D high|threshold/);
    expect(container.querySelector('.recharts-reference-line')).toBeNull();
    expect(screen.getByText('Normal (below Warning)')).toBeInTheDocument();
    expect(screen.getByText('Warning reached (>= 75)')).toBeInTheDocument();
    expect(screen.getByText('Critical reached (>= 90)')).toBeInTheDocument();
  });
  it('without rules there is a single plain line', () => {
    render(<TrendChart trend={trend(false)} />);
    expect(screen.getByText('Value')).toBeInTheDocument();
    expect(screen.queryByText(/Warning reached/)).toBeNull();
  });
  it('drag zooms to a window with a label, Reset zoom restores; Escape cancels a drag; a short drag does nothing', () => {
    const { container } = render(<TrendChart trend={trend()} />);
    const box = chart(container);
    const reset = screen.getByRole('button', { name: /Reset zoom/ });
    expect(reset).toBeDisabled();
    expect(screen.getByText(/^Showing: /)).toBeInTheDocument();

    fireEvent.pointerDown(box, { clientX: 100, button: 0 });
    fireEvent.pointerMove(box, { clientX: 400 });
    expect(container.querySelector('.bm-sel')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.bm-sel')).toBeNull();
    expect(reset).toBeDisabled();

    fireEvent.pointerDown(box, { clientX: 100, button: 0 });
    fireEvent.pointerUp(box, { clientX: 103 });
    expect(reset).toBeDisabled();

    fireEvent.pointerDown(box, { clientX: 100, button: 0 });
    fireEvent.pointerMove(box, { clientX: 500 });
    fireEvent.pointerUp(box, { clientX: 500 });
    expect(screen.getByText(/^Zoomed: /)).toBeInTheDocument();
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    expect(screen.getByText(/^Showing: /)).toBeInTheDocument();
    expect(reset).toBeDisabled();
  });
  it('reports the committed window to its owner and the reset as null', () => {
    const seen: unknown[] = [];
    const { container } = render(<TrendChart trend={trend()} onZoom={(w) => seen.push(w)} />);
    const box = chart(container);
    fireEvent.pointerDown(box, { clientX: 100, button: 0 });
    fireEvent.pointerUp(box, { clientX: 500 });
    expect(seen).toHaveLength(1);
    const w = seen[0] as [number, number];
    expect(w[1]).toBeGreaterThan(w[0]);
    fireEvent.click(screen.getByRole('button', { name: /Reset zoom/ }));
    expect(seen[1]).toBeNull();
  });
  it('window states: loading hint, error with Reset, empty window message, thinned hint; fetched points replace the client slice', () => {
    const win = (over: Partial<BamsTrend>): BamsTrend => ({ ...trend(), range: 'custom', points: [{ t: new Date(T0 + 3600e3).toISOString(), v: 50 }, { t: new Date(T0 + 3660e3).toISOString(), v: 80 }], sample_interval_seconds: 60, ...over });
    const zoomIn = (el: HTMLElement) => { const b = chart(el); fireEvent.pointerDown(b, { clientX: 100, button: 0 }); fireEvent.pointerUp(b, { clientX: 500 }); };
    const t = trend();
    const { container, rerender } = render(<TrendChart trend={t} windowFetch={{ data: null, loading: false, error: null }} />);
    zoomIn(container);
    rerender(<TrendChart trend={t} windowFetch={{ data: null, loading: true, error: null }} />);
    expect(screen.getByText('Loading finer data…')).toBeInTheDocument();
    expect(screen.getByText(/^Zoomed: /)).toBeInTheDocument(); // instant client-side zoom stays up
    rerender(<TrendChart trend={t} windowFetch={{ data: null, loading: false, error: Object.assign(new Error('x'), { fields: { to: 'The window can be at most 7 days.' } }) }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The window can be at most 7 days.');
    rerender(<TrendChart trend={t} windowFetch={{ data: win({ points: [] }), loading: false, error: null }} />);
    expect(screen.getByText('No samples in this window.')).toBeInTheDocument();
    rerender(<TrendChart trend={t} windowFetch={{ data: win({ downsampled: true }), loading: false, error: null }} />);
    expect(screen.getByText(/more than 2,000 samples/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Reset zoom/ })[0]);
    expect(screen.queryByText(/more than 2,000/)).toBeNull();
    expect(screen.getByText(/^Showing: /)).toBeInTheDocument();
  });
  it('a different range resets the zoom', () => {
    const { container, rerender } = render(<TrendChart trend={trend()} />);
    const box = chart(container);
    fireEvent.pointerDown(box, { clientX: 100, button: 0 });
    fireEvent.pointerUp(box, { clientX: 500 });
    expect(screen.getByText(/^Zoomed: /)).toBeInTheDocument();
    rerender(<TrendChart trend={{ ...trend(), range: '7d' }} />);
    expect(screen.getByText(/^Showing: /)).toBeInTheDocument();
  });
});

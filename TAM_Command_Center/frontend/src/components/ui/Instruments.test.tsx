import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, DatePill, DotRow, DueHistogram, ProgressRing, Sparkline, StackBar, SummaryChips, TimelineTrack } from './Instruments';
import { dueHistogram, timelineMarkers } from '../../lib/instruments';
import { buildChips, type Show } from '../../lib/triage';
import type { QueueItem, Task } from '../../types';

afterEach(() => cleanup());
const T = '2026-10-13';

describe('instruments carry text equivalents and no inline colours', () => {
  it('StackBar states the numbers and only omits empty segments', () => {
    const { container } = render(<StackBar meter={{ open: 12, overdue: 3, waiting: 2, other: 7 }} />);
    expect(screen.getByRole('img', { name: '12 open: 3 overdue, 2 waiting, 7 other' })).toBeInTheDocument();
    expect(container.querySelectorAll('i.seg')).toHaveLength(3);
    expect(container.innerHTML).not.toMatch(/color|background|#[0-9a-f]{3}/i);
    cleanup();
    const again = render(<StackBar meter={{ open: 2, overdue: 0, waiting: 0, other: 2 }} />);
    expect(again.container.querySelectorAll('i.seg')).toHaveLength(1);
  });

  it('Sparkline is named, drawn with a polyline, and replaced by "No trend data" below 2 points', () => {
    const { container } = render(<Sparkline values={[1, 3, 2]} label="CPU, last 7d, latest 2" tone="warning" />);
    expect(screen.getByRole('img', { name: 'CPU, last 7d, latest 2' })).toBeInTheDocument();
    expect(container.querySelector('polyline')).not.toBeNull();
    expect(container.querySelector('svg')!.getAttribute('preserveAspectRatio')).toBe('none');
    expect(container.querySelector('polyline')!.getAttribute('fill')).toBe('none');
    cleanup();
    render(<Sparkline values={[5]} label="x" />);
    expect(screen.getByText('No trend data')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('DueHistogram has 20 bars, per-bar titles, a text summary and a hidden table', () => {
    const t = (due: string): Task => ({ id: due + Math.random(), task: 'x', client_id: 'a', category: 'Other', priority: 'Low', due, next_update: null, status: 'Not Started', waiting: null, notes: null, archived: false, created_at: '', updated_at: '', row_version: 1 });
    const bins = dueHistogram([t('2026-10-10'), t(T), t(T)], T);
    const { container } = render(<DueHistogram bins={bins} today={T} />);
    expect(container.querySelectorAll('.duehist__bar')).toHaveLength(20);
    expect(container.querySelector('[title="13 Oct: 2 tasks"]')).not.toBeNull();
    expect(screen.getByRole('img', { name: /3 open tasks over 20 days: 1 overdue, 2 due today, 0 due in the next 13 days/ })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Open tasks by due date' })).toBeInTheDocument();
  });

  it('TimelineTrack lists every marker in a hidden table and prints the date of pinned markers', () => {
    const m = timelineMarkers([{ id: 'u', client_id: 'a', server_name: 'srv-1', environment: 'PROD', polarity: 'E', schedule_year: 2026, schedule_quarter: 'Q3', current_version: '1', target_version: '2', scheduled_date: '2026-07-26', maintenance_window: null, status: 'Exception', validation_status: 'Pending', waiting_on: null, reference: null, notes: null, updated_at: '', row_version: 1 }], T);
    render(<TimelineTrack markers={m} today={T} />);
    expect(screen.getByRole('table', { name: 'Upgrades in the next 30 days' })).toHaveTextContent('srv-1 to 2');
    expect(document.querySelector('.tmark__label')!.textContent).toContain('26 Jul');
  });

  it('ProgressRing is decorative (aria-hidden) and draws the fraction', () => {
    const { container } = render(<ProgressRing done={3} total={8} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const arc = container.querySelector('.ring__arc')!.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(arc[0] / arc[1]).toBeCloseTo(3 / 8, 2);
    expect(container.querySelector('.ring__check')).toBeNull();
    cleanup();
    expect(render(<ProgressRing done={8} total={8} />).container.querySelector('.ring__check')).not.toBeNull();
  });

  it('DotRow shows at most 12 dots then +n, with an accessible name', () => {
    const { container } = render(<DotRow dots={Array.from({ length: 15 }, () => ({ tone: null }))} label="15 servers, 0 with an alert" />);
    expect(container.querySelectorAll('.dotrow__dot')).toHaveLength(12);
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '15 servers, 0 with an alert' })).toBeInTheDocument();
  });

  it('Avatar is decorative; DatePill renders the date and relative text', () => {
    const { container } = render(<><Avatar name="Sofia Whitcombe" /><DatePill pill={{ date: '10 Oct', rel: '3d overdue', overdue: true, today: false }} /></>);
    expect(container.querySelector('.avatar')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.pill__rel--overdue')!.textContent).toBe('3d overdue');
  });
});

describe('SummaryChips', () => {
  const item = (tier: number, id: string): QueueItem => ({ kind: 'task', id, tier, tier_label: 'x', client_id: null, client_name: null, type_label: 'Task', title: id, status: 'Not Started', priority: 'Low', severity: null, urgency: 'overdue', date: null, date_kind: null, days_delta: null, context: null, server_name: null });
  function Harness() {
    const [v, setV] = useState<Show>('top');
    return <SummaryChips chips={buildChips([item(1, 'a'), item(1, 'b'), item(4, 'c')])} value={v} onChange={setV} label="Queue groups" />;
  }
  it('is a radiogroup with roving tabindex, arrows skip empty tiers, and empty chips are aria-disabled', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Queue groups' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(8);
    expect(group).toBeInTheDocument();
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Due today/ })).toHaveAttribute('aria-disabled', 'true');
    radios[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Overdue \/ critical/ })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}'); // t2, t3 are empty -> lands on Waiting
    expect(screen.getByRole('radio', { name: /Waiting/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: /Due today/ }));
    expect(screen.getByRole('radio', { name: /Waiting/ })).toHaveAttribute('aria-checked', 'true'); // empty chip is not selectable
  });
});

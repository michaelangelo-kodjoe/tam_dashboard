import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Upgrade30 } from '../../types';
import { UpgradeTimeline } from './UpgradeTimeline';

afterEach(() => cleanup());
const u = (o: Partial<Upgrade30>): Upgrade30 => ({ server_name: 'secret-host-01', date: '2026-11-05', status: 'Planned', environment: 'PROD', polarity: 'East', object_id: 'o', release: null, ...o });

describe('UpgradeTimeline', () => {
  it('populated: one marker per date and polarity with accessible names, a legend, no appliance names', () => {
    const { container } = render(<UpgradeTimeline today="2026-10-28" items={[u({}), u({ server_name: 'x2' }), u({ polarity: 'DEV', environment: 'DEV' }), u({ date: '2026-11-17', polarity: 'West' })]} />);
    const track = screen.getByRole('list', { name: 'Upgrades, Next 30 Days' });
    const marks = within(track).getAllByRole('img');
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['East PROD Upgrade, 5 Nov', 'DEV Upgrade, 5 Nov', 'West PROD Upgrade, 17 Nov']);
    expect(marks.every((m) => m.getAttribute('title') === m.getAttribute('aria-label'))).toBe(true);
    expect(marks[0].className).toMatch(/--east/); expect(marks[1].className).toMatch(/--dev/); expect(marks[2].className).toMatch(/--west/);
    expect(container.textContent).not.toMatch(/secret-host|x2/);
    expect(within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['West', 'East', 'DEV']);
    expect(screen.getAllByText('5 Nov')).toHaveLength(1); // two polarities share one date label
  });
  it('single marker', () => {
    render(<UpgradeTimeline today="2026-10-28" items={[u({ polarity: null })]} />);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'PROD Upgrade, 5 Nov');
    expect(screen.getByRole('list', { name: 'Legend' }).textContent).not.toMatch(/PROD|unknown/i); // unknown grey has no legend entry
  });
  it('empty', () => {
    render(<UpgradeTimeline today="2026-10-28" items={[]} />);
    expect(screen.getByText('No Upgrades In The Next 30 Days')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
  });
});

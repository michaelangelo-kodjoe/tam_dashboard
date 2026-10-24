import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { DataSource } from '../data/DataSource';
import { DataProvider, useQuery } from './DataContext';
import { cacheGet, shareStructure } from '../lib/queryCache';

function Probe({ k, fetcher, cache }: { k: string; fetcher: () => Promise<{ n: number }>; cache?: boolean }) {
  const q = useQuery(k, fetcher, { refreshMs: 1000, cache });
  return <div data-testid="o">{q.loading ? 'loading' : `n=${q.data?.n}${q.refreshing ? ' refreshing' : ''}`}</div>;
}

describe('useQuery stale-while-revalidate cache', () => {
  it('shows the last data instantly on remount while it refreshes in the background', async () => {
    const ds = {} as DataSource;
    let n = 0;
    const fetcher = vi.fn(async () => ({ n: ++n }));
    const first = render(<DataProvider ds={ds}><Probe k="c1" fetcher={fetcher} /></DataProvider>);
    await waitFor(() => expect(screen.getByTestId('o').textContent).toBe('n=1'));
    first.unmount();
    let release!: () => void;
    const slow = vi.fn(() => new Promise<{ n: number }>((r) => { release = () => r({ n: 2 }); }));
    render(<DataProvider ds={ds}><Probe k="c1" fetcher={slow} /></DataProvider>);
    expect(screen.getByTestId('o').textContent).toBe('n=1 refreshing'); // no loading flash
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId('o').textContent).toBe('n=2'));
  });

  it('keeps polling', async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      const fetcher = vi.fn(async () => ({ n: 1 }));
      render(<DataProvider ds={{} as DataSource}><Probe k="poll" fetcher={fetcher} /></DataProvider>);
      for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
      hidden = true; // paused while the tab is hidden
      const n = fetcher.mock.calls.length;
      for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetcher.mock.calls.length).toBe(n);
    } finally {
      vi.useRealTimers();
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('cache: false never shows or stores stale data (edit forms)', async () => {
    const ds = {} as DataSource;
    const fetcher = vi.fn(async () => ({ n: 5 }));
    const a = render(<DataProvider ds={ds}><Probe k="nc" fetcher={fetcher} cache={false} /></DataProvider>);
    await waitFor(() => expect(screen.getByTestId('o').textContent).toBe('n=5'));
    a.unmount();
    expect(cacheGet(ds, 'nc')).toBeUndefined();
    render(<DataProvider ds={ds}><Probe k="nc" fetcher={() => new Promise(() => undefined)} cache={false} /></DataProvider>);
    expect(screen.getByTestId('o').textContent).toBe('loading');
  });

  it('is scoped per data source', async () => {
    const a = {} as DataSource; const b = {} as DataSource;
    const r = render(<DataProvider ds={a}><Probe k="scope" fetcher={async () => ({ n: 9 })} /></DataProvider>);
    await waitFor(() => expect(screen.getByTestId('o').textContent).toBe('n=9'));
    r.unmount();
    render(<DataProvider ds={b}><Probe k="scope" fetcher={() => new Promise(() => undefined)} /></DataProvider>);
    expect(screen.getByTestId('o').textContent).toBe('loading');
  });

  it('shareStructure keeps the old reference for identical payloads', () => {
    const a = { x: [1, 2] };
    expect(shareStructure(a, { x: [1, 2] })).toBe(a);
    const c = { x: [3] };
    expect(shareStructure(a, c)).toBe(c);
  });
});

describe('useQuery keepPrevious', () => {
  it('keeps the old data on screen while a new key loads, so a filter change does not blank the page', async () => {
    const ds = {} as DataSource;
    const Keep = ({ k }: { k: string }) => {
      const q = useQuery(k, async () => (k === 'kp-a' ? { n: 1 } : new Promise<{ n: number }>(() => undefined)), { keepPrevious: true });
      return <div data-testid="kp">{q.loading ? 'loading' : `n=${q.data?.n}${q.refreshing ? ' refreshing' : ''}`}</div>;
    };
    const r = render(<DataProvider ds={ds}><Keep k="kp-a" /></DataProvider>);
    await waitFor(() => expect(screen.getByTestId('kp').textContent).toBe('n=1'));
    r.rerender(<DataProvider ds={ds}><Keep k="kp-b" /></DataProvider>);
    expect(screen.getByTestId('kp').textContent).toBe('n=1 refreshing');
  });
});

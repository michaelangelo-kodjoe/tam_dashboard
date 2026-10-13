// The ONE config value that swaps adapters (T-23 / T-40).
// Priority: ?data=mock|api in the URL (dev convenience) > VITE_DATA_SOURCE > default "mock".
// Phase 4.1 flips DEFAULT_SOURCE to "api"; no component code changes.
import type { DataSource } from './DataSource';
import { ApiDataSource } from './ApiDataSource';
import { MockDataSource } from './mock/MockDataSource';

const DEFAULT_SOURCE: 'mock' | 'api' = 'mock';

export function createDataSource(search: string = typeof location !== 'undefined' ? location.search : ''): DataSource {
  const params = new URLSearchParams(search);
  const choice = (params.get('data') ?? (import.meta.env.VITE_DATA_SOURCE as string | undefined) ?? DEFAULT_SOURCE).toLowerCase();
  if (choice === 'api') return new ApiDataSource();
  const delay = Number(params.get('mockDelay')) || 0;
  const today = params.get('mockToday') ?? undefined;
  return new MockDataSource({ delayMs: delay, today: today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined });
}

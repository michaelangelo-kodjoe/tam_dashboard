// The ONE config value that swaps adapters (T-23 / T-40).
// Priority: ?data=mock|api in the URL > sessionStorage (remembered for the tab session) >
// VITE_DATA_SOURCE > DEFAULT_SOURCE. Phase 4.1 (QA-E1-1): the default is the real API.
// "mock" is for DEV/demo only: a production build (VITE_DATA_SOURCE=api, see `npm run build:api`)
// does not ship mock_data.json, so there `?data=mock` is ignored and the API adapter is used.
import type { DataSource } from './DataSource';
import { ApiDataSource } from './ApiDataSource';
import { MockDataSource } from './mock/MockDataSource';

const DEFAULT_SOURCE: 'mock' | 'api' = 'api';
const STORAGE_KEY = 'tam.dataSource';

function remembered(): string | null {
  try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function remember(v: string): void {
  try { sessionStorage.setItem(STORAGE_KEY, v); } catch { /* storage unavailable: choice just is not remembered */ }
}

export function createDataSource(search: string = typeof location !== 'undefined' ? location.search : ''): DataSource {
  const params = new URLSearchParams(search);
  const fromUrl = params.get('data')?.toLowerCase();
  if (fromUrl === 'mock' || fromUrl === 'api') remember(fromUrl);
  const stored = remembered();
  const env = import.meta.env.VITE_DATA_SOURCE as string | undefined;
  let choice = (fromUrl === 'mock' || fromUrl === 'api' ? fromUrl : stored === 'mock' || stored === 'api' ? stored : (env ?? DEFAULT_SOURCE)).toLowerCase();
  if (choice === 'mock' && env === 'api' && !import.meta.env.DEV) choice = 'api';
  if (choice !== 'mock') return new ApiDataSource();
  const delay = Number(params.get('mockDelay')) || 0;
  const today = params.get('mockToday') ?? undefined;
  return new MockDataSource({ delayMs: delay, today: today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : undefined });
}

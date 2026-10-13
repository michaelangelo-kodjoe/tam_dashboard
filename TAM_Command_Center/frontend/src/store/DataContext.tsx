import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataSource } from '../data/DataSource';
import type { AppState, AccountSummary, Settings } from '../types';

interface DataCtx {
  ds: DataSource;
  /** Incremented after every mutation; all queries refetch (Today refreshes after every mutation, US-3.5). */
  version: number;
  bump: () => void;
}
const Ctx = createContext<DataCtx | null>(null);

export function DataProvider({ ds, children }: { ds: DataSource; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ ds, version, bump }), [ds, version, bump]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): DataCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData must be used inside <DataProvider>');
  return v;
}

export interface QueryResult<T> {
  data: T | null;
  /** first load, no data yet */
  loading: boolean;
  /** a refetch is in flight while earlier data is shown */
  refreshing: boolean;
  /** latest fetch failed and there is no earlier data */
  error: unknown;
  /** latest fetch failed but earlier data is still shown (cached/stale) */
  stale: boolean;
  staleError: unknown;
  /** time of the last successful load */
  lastOk: Date | null;
  reload: () => void;
}

/**
 * Cached query bound to the data version. Earlier data is kept while refreshing and when a
 * refresh fails (flagged `stale`). A different `key` resets the cache for that query.
 */
export function useQuery<T>(key: string, fetcher: (ds: DataSource) => Promise<T>, opts: { enabled?: boolean; refreshMs?: number | null } = {}): QueryResult<T> {
  const { ds, version } = useData();
  const enabled = opts.enabled ?? true;
  const [st, setSt] = useState<{ key: string; data: T | null; error: unknown; staleError: unknown; lastOk: Date | null; inflight: boolean }>({
    key, data: null, error: null, staleError: null, lastOk: null, inflight: enabled,
  });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    const id = ++seq.current;
    setSt((s) => (s.key === key ? { ...s, inflight: true } : { key, data: null, error: null, staleError: null, lastOk: null, inflight: true }));
    fetcherRef.current(ds).then(
      (data) => {
        if (id !== seq.current) return;
        setSt({ key, data, error: null, staleError: null, lastOk: new Date(), inflight: false });
      },
      (err) => {
        if (id !== seq.current) return;
        setSt((s) => (s.key === key && s.data !== null ? { ...s, staleError: err, inflight: false } : { key, data: null, error: err, staleError: null, lastOk: null, inflight: false }));
      },
    );
    return () => {
      // a newer effect run supersedes this one via seq
    };
  }, [ds, key, version, tick, enabled]);

  useEffect(() => {
    if (!opts.refreshMs) return;
    const h = setInterval(() => setTick((n) => n + 1), opts.refreshMs);
    return () => clearInterval(h);
  }, [opts.refreshMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const cur = st.key === key ? st : { data: null, error: null, staleError: null, lastOk: null, inflight: enabled };
  return {
    data: cur.data,
    loading: cur.data === null && cur.error === null && (cur.inflight || !enabled),
    refreshing: cur.data !== null && cur.inflight,
    error: cur.error,
    stale: cur.data !== null && cur.staleError !== null,
    staleError: cur.staleError,
    lastOk: cur.lastOk,
    reload,
  };
}

// ---------------------------------------------------------------- app state

interface AppCtx {
  state: AppState;
  accounts: AccountSummary[];
  accountById: (id: string | null | undefined) => AccountSummary | undefined;
  settings: Settings;
  today: string;
  stale: boolean;
  lastOk: Date | null;
  reload: () => void;
}
const AppContext = createContext<AppCtx | null>(null);

export function AppStateProvider({ state, stale, lastOk, reload, children }: { state: AppState; stale: boolean; lastOk: Date | null; reload: () => void; children: ReactNode }) {
  const value = useMemo<AppCtx>(() => {
    const map = new Map(state.accounts.map((a) => [a.id, a]));
    return { state, accounts: state.accounts, accountById: (id) => (id ? map.get(id) : undefined), settings: state.settings, today: state.today, stale, lastOk, reload };
  }, [state, stale, lastOk, reload]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp must be used inside <AppStateProvider>');
  return v;
}

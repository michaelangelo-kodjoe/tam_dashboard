// Stale-while-revalidate cache for useQuery. Module level, so it survives page navigation (a BAMS tab
// switch shows the last data instantly while a background refresh runs). One map per data source.
interface Entry<T = unknown> { data: T; lastOk: Date }
const MAX_ENTRIES = 80;
const stores = new WeakMap<object, Map<string, Entry>>();

function store(scope: object): Map<string, Entry> {
  let m = stores.get(scope);
  if (!m) { m = new Map(); stores.set(scope, m); }
  return m;
}

export function cacheGet<T>(scope: object, key: string): Entry<T> | undefined {
  return store(scope).get(key) as Entry<T> | undefined;
}

export function cacheSet<T>(scope: object, key: string, data: T, lastOk: Date): void {
  const m = store(scope);
  m.delete(key); // re-insert so the oldest key is first
  m.set(key, { data, lastOk });
  while (m.size > MAX_ENTRIES) m.delete(m.keys().next().value as string);
}

export function cacheClear(scope: object): void {
  stores.delete(scope);
}

/** Keep the previous object when the new payload is identical, so memoised children do not re-render on every poll. */
export function shareStructure<T>(prev: T | null | undefined, next: T): T {
  if (prev == null) return next;
  try { return JSON.stringify(prev) === JSON.stringify(next) ? prev : next; } catch { return next; }
}

// In-flight de-duplication: one request per (scope, key, data version). A second caller, a poll tick or a
// reload while it is pending reuses the same promise. A newer data version (after a mutation) starts a fresh
// request, so post-mutation data is never served from a pre-mutation request. Settled promises are removed,
// so errors retry on the next tick exactly as before.
interface Flight { p: Promise<unknown>; version: number }
const flights = new WeakMap<object, Map<string, Flight>>();

export function sharedFetch<T>(scope: object, key: string, version: number, start: () => Promise<T>): Promise<T> {
  let m = flights.get(scope);
  if (!m) { m = new Map(); flights.set(scope, m); }
  const cur = m.get(key);
  if (cur && cur.version === version) return cur.p as Promise<T>;
  const flight: Flight = { version, p: undefined as unknown as Promise<unknown> };
  const clear = () => { if (m!.get(key) === flight) m!.delete(key); };
  flight.p = start().then(
    (v) => { clear(); return v; },
    (e) => { clear(); throw e; },
  );
  m.set(key, flight);
  return flight.p as Promise<T>;
}

export function isInFlight(scope: object, key: string): boolean {
  return flights.get(scope)?.has(key) ?? false;
}

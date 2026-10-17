import { useEffect, useState, useSyncExternalStore } from 'react';
import { getTimeFormat, subscribeTimeFormat, type TimeFormat } from './dates';

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return m;
}

export function useNow(intervalMs = 30_000): Date {
  const [n, setN] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setN(new Date()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return n;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · TAM Command Center` : 'TAM Command Center';
  }, [title]);
}

/** Re-render when the 12/24-hour preference changes. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(subscribeTimeFormat, getTimeFormat);
}

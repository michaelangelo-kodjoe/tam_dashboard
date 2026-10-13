import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDataSource } from './index';

// QA-E1-1: the API adapter is the default; ?data=mock is a DEV/demo switch remembered per tab session.
describe('createDataSource (QA-E1-1)', () => {
  beforeEach(() => { try { sessionStorage.clear(); } catch { /* ignore */ } });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to the API adapter', () => {
    expect(createDataSource('').kind).toBe('api');
  });
  it('?data=mock selects mock and is remembered across a reload (no query string)', () => {
    expect(createDataSource('?data=mock').kind).toBe('mock');
    expect(createDataSource('').kind).toBe('mock');
  });
  it('?data=api overrides and replaces the remembered choice', () => {
    createDataSource('?data=mock');
    expect(createDataSource('?data=api').kind).toBe('api');
    expect(createDataSource('').kind).toBe('api');
  });
  it('ignores unknown values and still works when sessionStorage throws', () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(createDataSource('?data=bogus').kind).toBe('api');
    expect(createDataSource('?data=mock').kind).toBe('mock');
  });
});

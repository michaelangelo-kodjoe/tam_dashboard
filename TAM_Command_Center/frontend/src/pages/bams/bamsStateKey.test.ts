import { describe, expect, it } from 'vitest';
import { bamsStateKey } from './DashboardPage';

describe('bamsStateKey', () => {
  it('ignores open and uses only the settled search text', () => {
    const sp = new URLSearchParams('status=down&q=ab&open=7');
    expect(bamsStateKey(sp, undefined)).toBe('bams-state:status=down');
    expect(bamsStateKey(sp, 'abc')).toBe('bams-state:status=down&q=abc');
    expect(bamsStateKey(new URLSearchParams('q=abcd'), 'abc')).toBe(bamsStateKey(new URLSearchParams('q=abc'), 'abc'));
  });
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ScanCache } from '../src/cache.js';
import { SCAN_CACHE_TTL_MS } from '../src/constants.js';

describe('ScanCache', () => {
  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns null for missing key', () => {
    const cache = new ScanCache<number>();
    expect(cache.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    const cache = new ScanCache<number>();
    cache.set('key', 42);
    const result = cache.get('key');
    expect(result).not.toBeNull();
    expect(result!.data).toBe(42);
  });

  it('tracks age in milliseconds', () => {
    const cache = new ScanCache<string>();
    cache.set('key', 'value');
    vi.advanceTimersByTime(5000);
    const result = cache.get('key');
    expect(result).not.toBeNull();
    expect(result!.ageMs).toBeGreaterThanOrEqual(5000);
  });

  it('expires entries after TTL', () => {
    const cache = new ScanCache<string>();
    cache.set('key', 'value');
    vi.advanceTimersByTime(SCAN_CACHE_TTL_MS + 1);
    expect(cache.get('key')).toBeNull();
  });

  it('does not expire entries before TTL', () => {
    const cache = new ScanCache<string>();
    cache.set('key', 'value');
    vi.advanceTimersByTime(SCAN_CACHE_TTL_MS - 1);
    expect(cache.get('key')).not.toBeNull();
  });

  it('overwrites existing key with fresh timestamp', () => {
    const cache = new ScanCache<number>();
    cache.set('key', 1);
    vi.advanceTimersByTime(30_000);
    cache.set('key', 2);
    vi.advanceTimersByTime(40_000); // 70s from first set, 40s from second
    const result = cache.get('key');
    expect(result).not.toBeNull();
    expect(result!.data).toBe(2);
  });

  it('handles multiple keys independently', () => {
    const cache = new ScanCache<string>();
    cache.set('a', 'alpha');
    vi.advanceTimersByTime(30_000);
    cache.set('b', 'beta');
    vi.advanceTimersByTime(SCAN_CACHE_TTL_MS - 29_000); // a expired, b alive
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).not.toBeNull();
    expect(cache.get('b')!.data).toBe('beta');
  });

  it('evicts expired entries when store exceeds 1000', () => {
    const cache = new ScanCache<number>();
    for (let i = 0; i < 1001; i++) {
      cache.set(`key-${i}`, i);
    }
    vi.advanceTimersByTime(SCAN_CACHE_TTL_MS + 1);
    cache.set('fresh', 999);
    expect(cache.get('fresh')!.data).toBe(999);
    expect(cache.get('key-0')).toBeNull();
  });
});

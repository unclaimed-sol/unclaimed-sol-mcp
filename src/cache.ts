import { SCAN_CACHE_TTL_MS } from './constants.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class ScanCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): { data: T; ageMs: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    const ageMs = Date.now() - entry.timestamp;
    if (ageMs > SCAN_CACHE_TTL_MS) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return { data: entry.data, ageMs };
  }

  set(key: string, data: T): void {
    this.evictExpired();
    this.store.delete(key);
    while (this.store.size >= 256) this.store.delete(this.store.keys().next().value!);
    this.store.set(key, { data, timestamp: Date.now() });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.timestamp > SCAN_CACHE_TTL_MS) this.store.delete(key);
    }
  }
}

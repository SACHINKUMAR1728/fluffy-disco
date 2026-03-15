import { EventEmitter } from 'events';
import { LRUCache } from 'lru-cache';

// ---------------------------------------------------------------------------
//  TypeScript interfaces
// ---------------------------------------------------------------------------

export interface HotKeyCacheOptions {
  /** Number of hits within windowMs before a key is promoted to the LRU. */
  threshold?: number;
  /** Sliding-window duration in ms for the frequency counter. */
  windowMs?: number;
  /** Maximum number of LRU entries. */
  maxCacheSize?: number;
  /** Default TTL per cached entry in ms. */
  ttlMs?: number;
  /** Hard memory cap in MB (uses lru-cache sizeCalculation). */
  maxMemoryMb?: number;
  /** How often the frequency-counter cleanup runs in ms. */
  cleanupIntervalMs?: number;
  /** Per-prefix threshold overrides, e.g. `{ 'user:': 20, 'config:': 5 }` */
  prefixThresholds?: Record<string, number>;
  /** When true, very hot keys get extended TTL. */
  adaptiveTtl?: boolean;
}

export interface CacheStats {
  cachedKeys: number;
  hitRate: number;
  totalRequests: number;
  cacheHits: number;
  hotKeys: string[];
}

export interface CacheHitPayload      { key: string; hits: number }
export interface CacheMissPayload     { key: string; hits: number }
export interface CachePromotedPayload { key: string; hits: number; ttl: number }
export interface CacheInvalidatedPayload { key: string }
export interface CacheEvictedPayload  { key: string }

// Internal box type — wraps any value (including null/undefined) so we satisfy
// lru-cache v10's `V extends {}` constraint on the value generic.
interface Box { v: unknown }

// ---------------------------------------------------------------------------
//  FrequencyCounter — sliding-window hit counter per key
// ---------------------------------------------------------------------------

interface WindowEntry { count: number; windowStart: number }

export class FrequencyCounter {
  private readonly windowMs: number;
  private readonly windows: Map<string, WindowEntry>;

  constructor({ windowMs = 60_000 }: { windowMs?: number } = {}) {
    this.windowMs = windowMs;
    this.windows = new Map();
  }

  /** Increment the counter for `key` and return the new count. Never throws. */
  increment(key: string): number {
    try {
      const now = Date.now();
      const entry = this.windows.get(key);
      if (!entry || now - entry.windowStart >= this.windowMs) {
        this.windows.set(key, { count: 1, windowStart: now });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    } catch {
      return 0;
    }
  }

  /** Return the current hit count for `key` (0 if unknown or expired). Never throws. */
  get(key: string): number {
    try {
      const entry = this.windows.get(key);
      if (!entry) return 0;
      if (Date.now() - entry.windowStart >= this.windowMs) {
        this.windows.delete(key);
        return 0;
      }
      return entry.count;
    } catch {
      return 0;
    }
  }

  /** Remove all windows that have expired. Never throws. */
  cleanup(): void {
    try {
      const now = Date.now();
      for (const [key, entry] of this.windows) {
        if (now - entry.windowStart >= this.windowMs) {
          this.windows.delete(key);
        }
      }
    } catch {
      // silently degrade
    }
  }
}

// ---------------------------------------------------------------------------
//  HotKeyCache — LRU cache promoted only for frequently accessed keys
// ---------------------------------------------------------------------------

export class HotKeyCache extends EventEmitter {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly ttlMs: number;
  private readonly adaptiveTtl: boolean;
  private readonly prefixThresholds: Record<string, number>;

  private readonly counter: FrequencyCounter;
  // Values are boxed in { v: ... } so that null/undefined can be stored
  // while satisfying lru-cache v10's V extends {} constraint.
  private readonly lru: LRUCache<string, Box>;
  private readonly inflight: Map<string, Promise<unknown>>;

  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  private totalRequests = 0;
  private cacheHits = 0;

  constructor(options: HotKeyCacheOptions = {}) {
    super();

    this.threshold        = options.threshold        ?? 50;
    this.windowMs         = options.windowMs         ?? 60_000;
    this.ttlMs            = options.ttlMs            ?? 5_000;
    this.adaptiveTtl      = options.adaptiveTtl      ?? true;
    this.prefixThresholds = options.prefixThresholds ?? {};

    const maxMemoryBytes = Math.floor((options.maxMemoryMb ?? 50) * 1024 * 1024);

    this.counter  = new FrequencyCounter({ windowMs: this.windowMs });
    this.inflight = new Map();

    this.lru = new LRUCache<string, Box>({
      max: options.maxCacheSize ?? 500,
      ttl: this.ttlMs,
      maxSize: maxMemoryBytes,
      sizeCalculation: (box) => {
        try {
          return Buffer.byteLength(JSON.stringify(box.v), 'utf8') + 8;
        } catch {
          return 72; // fallback size
        }
      },
      dispose: (_box, key) => {
        this.emit('cache:evicted', { key } satisfies CacheEvictedPayload);
      },
    });

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => {
      this.counter.cleanup();
    }, cleanupIntervalMs);

    // Allow process to exit even if this timer is running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  // -------------------------------------------------------------------------
  //  Private helpers
  // -------------------------------------------------------------------------

  /** Return the threshold that applies to `key` (longest prefix wins). */
  private resolveThreshold(key: string): number {
    let bestPrefix = '';
    let bestThreshold = this.threshold;

    for (const [prefix, thresh] of Object.entries(this.prefixThresholds)) {
      if (key.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        bestThreshold = thresh;
      }
    }

    return bestThreshold;
  }

  /** Compute adaptive TTL based on how hot a key is relative to the threshold. */
  private computeTtl(hits: number, threshold: number): number {
    const ratio = hits / threshold;
    if (ratio > 10) return this.ttlMs * 3;
    if (ratio > 5)  return this.ttlMs * 2;
    return this.ttlMs;
  }

  // -------------------------------------------------------------------------
  //  Core method
  // -------------------------------------------------------------------------

  /**
   * Get a value, serving from cache for hot keys and de-duping concurrent
   * fetches (thundering herd prevention).
   *
   * @param key      Cache key
   * @param fetchFn  Function that fetches the real value when needed
   */
  async get<T>(key: string, fetchFn: (key: string) => Promise<T>): Promise<T> {
    this.totalRequests += 1;
    const hits = this.counter.increment(key);

    // ── 1. LRU hit ─────────────────────────────────────────────────────────
    const cached = this.lru.get(key);
    if (cached !== undefined) {
      this.cacheHits += 1;
      this.emit('cache:hit', { key, hits } satisfies CacheHitPayload);
      return cached.v as T;
    }

    // ── 2. Thundering-herd dedup ────────────────────────────────────────────
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    // ── 3. Fetch from source ────────────────────────────────────────────────
    const fetching = (async (): Promise<T> => {
      try {
        const value = await fetchFn(key);

        const threshold = this.resolveThreshold(key);
        if (hits >= threshold) {
          const ttl = this.adaptiveTtl ? this.computeTtl(hits, threshold) : this.ttlMs;
          this.lru.set(key, { v: value }, { ttl });
          this.emit('cache:promoted', { key, hits, ttl } satisfies CachePromotedPayload);
        }

        this.emit('cache:miss', { key, hits } satisfies CacheMissPayload);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, fetching);
    return fetching;
  }

  // -------------------------------------------------------------------------
  //  Invalidation
  // -------------------------------------------------------------------------

  /** Remove a single key from the LRU cache. */
  invalidate(key: string): void {
    this.lru.delete(key);
    this.emit('cache:invalidated', { key } satisfies CacheInvalidatedPayload);
  }

  /** Remove multiple keys from the LRU cache. */
  invalidateMany(keys: string[]): void {
    for (const key of keys) {
      this.invalidate(key);
    }
  }

  /** Remove all cached keys that start with `prefix`. */
  invalidateByPrefix(prefix: string): void {
    for (const key of this.lru.keys()) {
      if (key.startsWith(prefix)) {
        this.invalidate(key);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Stats
  // -------------------------------------------------------------------------

  get stats(): CacheStats {
    const hotKeys: string[] = [];
    for (const key of this.lru.keys()) {
      hotKeys.push(key);
    }

    return {
      cachedKeys: this.lru.size,
      hitRate: this.totalRequests === 0 ? 0 : this.cacheHits / this.totalRequests,
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      hotKeys,
    };
  }

  // -------------------------------------------------------------------------
  //  Lifecycle
  // -------------------------------------------------------------------------

  /** Clear all timers and the LRU cache. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.lru.clear();
    this.inflight.clear();
    this.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
//  Singleton — import and reuse this across the codebase
// ---------------------------------------------------------------------------

export const hotCache = new HotKeyCache({
  threshold: 50,
  windowMs: 60_000,
  maxCacheSize: 500,
  ttlMs: 5_000,
  maxMemoryMb: 50,
  cleanupIntervalMs: 30_000,
  adaptiveTtl: true,
  prefixThresholds: {
    // Shard health checks are frequent — promote them after just 10 hits
    'shard:': 10,
  },
});

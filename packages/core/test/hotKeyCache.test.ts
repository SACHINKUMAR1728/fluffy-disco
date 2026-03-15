import { FrequencyCounter, HotKeyCache } from '../src/lib/hotKeyCache.js';

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeFetch<T>(returnValue: T) {
  return jest.fn().mockResolvedValue(returnValue);
}

// Default options that make tests fast: threshold=3, ttlMs=1000
const fastOpts = {
  threshold: 3,
  windowMs: 5_000,
  ttlMs: 1_000,
  cleanupIntervalMs: 999_999, // Don't trigger during test
  maxCacheSize: 100,
  maxMemoryMb: 10,
};

// ---------------------------------------------------------------------------
//  FrequencyCounter
// ---------------------------------------------------------------------------

describe('FrequencyCounter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('increment returns 1 on first call', () => {
    const fc = new FrequencyCounter({ windowMs: 60_000 });
    expect(fc.increment('key1')).toBe(1);
  });

  it('increment accumulates within the same window', () => {
    const fc = new FrequencyCounter({ windowMs: 60_000 });
    fc.increment('key1');
    fc.increment('key1');
    expect(fc.increment('key1')).toBe(3);
  });

  it('get returns 0 for unknown key', () => {
    const fc = new FrequencyCounter({ windowMs: 60_000 });
    expect(fc.get('nope')).toBe(0);
  });

  it('window expires after windowMs and returns 0', () => {
    const fc = new FrequencyCounter({ windowMs: 1_000 });
    fc.increment('key1');
    fc.increment('key1');
    expect(fc.get('key1')).toBe(2);

    jest.advanceTimersByTime(1_001);
    expect(fc.get('key1')).toBe(0);
  });

  it('increment starts fresh window after expiry', () => {
    const fc = new FrequencyCounter({ windowMs: 1_000 });
    fc.increment('key1');
    fc.increment('key1');
    jest.advanceTimersByTime(1_001);
    // After expiry, first increment in new window = 1
    expect(fc.increment('key1')).toBe(1);
  });

  it('cleanup removes expired windows', () => {
    const fc = new FrequencyCounter({ windowMs: 1_000 });
    fc.increment('key1');
    fc.increment('key2');
    jest.advanceTimersByTime(1_001);
    fc.cleanup();
    // After cleanup, get should return 0
    expect(fc.get('key1')).toBe(0);
    expect(fc.get('key2')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  HotKeyCache — get()
// ---------------------------------------------------------------------------

describe('HotKeyCache.get()', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache(fastOpts);
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  it('returns value from fetchFn on first call', async () => {
    const fetch = makeFetch({ data: 42 });
    const result = await cache.get('key1', fetch);
    expect(result).toEqual({ data: 42 });
  });

  it('calls fetchFn exactly once on cache miss', async () => {
    const fetch = makeFetch('value');
    await cache.get('key1', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached value without calling fetchFn on second call (cache hit)', async () => {
    const fetch = makeFetch('v');
    // threshold=3, so we call 3 times to promote
    await cache.get('k', fetch);
    await cache.get('k', fetch);
    await cache.get('k', fetch); // 3rd call → promoted
    fetch.mockClear();
    // 4th call → from LRU, fetchFn NOT called
    const result = await cache.get('k', fetch);
    expect(result).toBe('v');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does NOT cache key below threshold', async () => {
    const fetch = makeFetch('v');
    // threshold=3; do only 2 calls
    await cache.get('k', fetch);
    await cache.get('k', fetch);
    expect(cache.stats.cachedKeys).toBe(0);
  });

  it('DOES cache key at exactly threshold', async () => {
    const fetch = makeFetch('v');
    await cache.get('k', fetch);
    await cache.get('k', fetch);
    await cache.get('k', fetch); // hits threshold = 3
    expect(cache.stats.cachedKeys).toBe(1);
  });

  it('concurrent requests for same uncached key → fetchFn called exactly once (thundering herd)', async () => {
    const fetch = jest.fn().mockImplementation(async () => {
      // Simulate async work
      await Promise.resolve();
      return 'shared-value';
    });

    // Fire 10 concurrent gets before any resolves
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.get('stampede-key', fetch))
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r === 'shared-value')).toBe(true);
  });

  it('fetchFn rejection propagates correctly and clears inflight entry', async () => {
    const err = new Error('db down');
    const fetch = jest.fn().mockRejectedValue(err);

    await expect(cache.get('bad-key', fetch)).rejects.toThrow('db down');

    // inflight must be cleared — next call should invoke fetchFn again
    const fetch2 = makeFetch('recovered');
    const result = await cache.get('bad-key', fetch2);
    expect(result).toBe('recovered');
    expect(fetch2).toHaveBeenCalledTimes(1);
  });

  it('TTL expiry causes re-fetch (real timers)', async () => {
    // Use real timers because lru-cache relies on real Date.now() for TTL
    jest.useRealTimers();
    const shortCache = new HotKeyCache({
      threshold: 2,
      windowMs: 60_000,
      ttlMs: 50,           // 50 ms TTL
      cleanupIntervalMs: 999_999,
      maxCacheSize: 100,
      maxMemoryMb: 10,
      adaptiveTtl: false,
    });

    const fetch = makeFetch('fresh');
    await shortCache.get('ttl-key', fetch);
    await shortCache.get('ttl-key', fetch); // promoted
    fetch.mockClear();

    // Wait past TTL
    await delay(80);

    await shortCache.get('ttl-key', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    shortCache.destroy();
  });

  it('adaptive TTL: key at 10x threshold gets ttl*3', async () => {
    // Use real timers — lru-cache relies on real Date.now() for TTL
    jest.useRealTimers();

    // threshold=2, windowMs=60s (all hits accumulate in one window), ttlMs=50ms
    const adaptiveCache = new HotKeyCache({
      threshold: 2,
      windowMs: 60_000,
      ttlMs: 50,
      cleanupIntervalMs: 999_999,
      maxCacheSize: 100,
      maxMemoryMb: 10,
      adaptiveTtl: true,
    });

    const promotedEvents: { ttl: number }[] = [];
    adaptiveCache.on('cache:promoted', (payload: { ttl: number }) =>
      promotedEvents.push(payload)
    );

    const fetch = jest.fn().mockResolvedValue('hot');

    // Invalidate after each promotion so every get() is a cache miss
    // and the hit counter keeps growing unbounded within the window.
    adaptiveCache.on('cache:promoted', () => {
      adaptiveCache.invalidate('very-hot');
    });

    // Fire 22 requests — each hits the miss path, incrementing the counter.
    // At hit 2 (ratio=1) first promotion fires → invalidated immediately.
    // At hit 22 (ratio=11 > 10) last promotion fires → ttl*3.
    for (let i = 0; i < 22; i++) {
      await adaptiveCache.get('very-hot', fetch);
    }

    // First promotion: ratio = 2/2 = 1  →  ttl * 1 = 50
    expect(promotedEvents[0].ttl).toBe(50);
    // Last promotion:  ratio = 22/2 = 11 > 10  →  ttl * 3 = 150
    expect(promotedEvents[promotedEvents.length - 1].ttl).toBe(150);

    adaptiveCache.destroy();
  });
});

// ---------------------------------------------------------------------------
//  Invalidation
// ---------------------------------------------------------------------------

describe('HotKeyCache — invalidation', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache(fastOpts);
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  async function promoteKey(key: string, value: unknown) {
    const fetch = makeFetch(value);
    for (let i = 0; i < fastOpts.threshold; i++) {
      await cache.get(key, fetch);
    }
    return fetch;
  }

  it('invalidate() removes key from cache', async () => {
    await promoteKey('k1', 'val');
    expect(cache.stats.cachedKeys).toBe(1);
    cache.invalidate('k1');
    expect(cache.stats.cachedKeys).toBe(0);
  });

  it('invalidateMany() removes all specified keys', async () => {
    await promoteKey('a', 1);
    await promoteKey('b', 2);
    await promoteKey('c', 3);
    expect(cache.stats.cachedKeys).toBe(3);
    cache.invalidateMany(['a', 'c']);
    expect(cache.stats.cachedKeys).toBe(1);
    expect(cache.stats.hotKeys).toEqual(['b']);
  });

  it('invalidateByPrefix() removes only matching keys', async () => {
    await promoteKey('user:1', 'u1');
    await promoteKey('user:2', 'u2');
    await promoteKey('order:1', 'o1');
    cache.invalidateByPrefix('user:');
    expect(cache.stats.cachedKeys).toBe(1);
    expect(cache.stats.hotKeys).toEqual(['order:1']);
  });
});

// ---------------------------------------------------------------------------
//  Events
// ---------------------------------------------------------------------------

describe('HotKeyCache — events', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache({ ...fastOpts, threshold: 2 });
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  it('cache:miss emitted with correct payload', async () => {
    const misses: unknown[] = [];
    cache.on('cache:miss', (p) => misses.push(p));
    await cache.get('m', makeFetch('v'));
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ key: 'm', hits: 1 });
  });

  it('cache:hit emitted with correct payload', async () => {
    const hits: unknown[] = [];
    cache.on('cache:hit', (p) => hits.push(p));
    const fetch = makeFetch('v');
    // Promote: threshold=2
    await cache.get('h', fetch);
    await cache.get('h', fetch); // promoted
    await cache.get('h', fetch); // LRU hit → event
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ key: 'h', hits: 3 });
  });

  it('cache:promoted emitted when threshold crossed', async () => {
    const promoted: unknown[] = [];
    cache.on('cache:promoted', (p) => promoted.push(p));
    const fetch = makeFetch('v');
    await cache.get('p', fetch); // hits=1
    await cache.get('p', fetch); // hits=2 → threshold=2, promoted!
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ key: 'p', hits: 2 });
  });

  it('cache:invalidated emitted on invalidate()', async () => {
    const evts: unknown[] = [];
    cache.on('cache:invalidated', (p) => evts.push(p));
    cache.invalidate('any-key');
    expect(evts).toHaveLength(1);
    expect(evts[0]).toMatchObject({ key: 'any-key' });
  });
});

// ---------------------------------------------------------------------------
//  Prefix thresholds
// ---------------------------------------------------------------------------

describe('HotKeyCache — prefix thresholds', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache({
      ...fastOpts,
      threshold: 10,
      prefixThresholds: {
        'user:': 2,
        'user:admin:': 1, // longer prefix
        'config:': 5,
      },
    });
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  it('key matching prefix uses prefix threshold, not global', async () => {
    const fetch = makeFetch('u');
    // global threshold=10, user: threshold=2
    await cache.get('user:42', fetch); // hits=1 — not yet
    await cache.get('user:42', fetch); // hits=2 → promoted (prefix threshold)
    expect(cache.stats.cachedKeys).toBe(1);
  });

  it('longest prefix wins when multiple prefixes match', async () => {
    const fetch = makeFetch('admin');
    // 'user:admin:1' matches both 'user:' (thresh=2) and 'user:admin:' (thresh=1)
    // Longest match wins → threshold=1
    await cache.get('user:admin:1', fetch); // hits=1 → promoted
    expect(cache.stats.cachedKeys).toBe(1);
  });

  it('key with no matching prefix uses global threshold', async () => {
    const fetch = makeFetch('p');
    // global threshold=10
    for (let i = 0; i < 9; i++) {
      await cache.get('product:99', fetch);
    }
    expect(cache.stats.cachedKeys).toBe(0);
    await cache.get('product:99', fetch); // hit 10 → promoted
    expect(cache.stats.cachedKeys).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  Memory cap
// ---------------------------------------------------------------------------

describe('HotKeyCache — memory cap', () => {
  it('keys are evicted when maxMemoryMb is effectively exceeded', async () => {
    // maxMemoryMb: 0.002 = Math.floor(0.002 * 1024 * 1024) = 2097 bytes
    // Each value is ~530 bytes → eviction starts at ~4th entry
    const cache = new HotKeyCache({
      threshold: 1,
      windowMs: 60_000,
      ttlMs: 60_000,
      cleanupIntervalMs: 999_999,
      maxCacheSize: 10_000,
      maxMemoryMb: 0.002, // ~2 KB
    });

    const evicted: string[] = [];
    cache.on('cache:evicted', ({ key }: { key: string }) => evicted.push(key));

    // Each value is ~500 bytes; with a 2 KB cap, eviction starts at ~5th entry
    for (let i = 0; i < 10; i++) {
      const bigValue = { id: i, data: 'x'.repeat(500) };
      await cache.get(`mem:${i}`, async () => bigValue);
    }

    expect(evicted.length).toBeGreaterThan(0);
    cache.destroy();
  });
});

// ---------------------------------------------------------------------------
//  Integration — full read/write cycle
// ---------------------------------------------------------------------------

describe('HotKeyCache — integration: read/write cycle', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache({ ...fastOpts, threshold: 2 });
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  it('write → read → assert fetchFn NOT called twice (cached)', async () => {
    const fetch = makeFetch({ name: 'Alice' });
    // Promote
    await cache.get('user:1', fetch);
    await cache.get('user:1', fetch); // promoted at threshold=2
    fetch.mockClear();

    // "Write" == invalidate + reset; simulate an app write followed by a read
    // Here we just read again — should be from cache, fetch NOT called
    await cache.get('user:1', fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('write → update → read → assert fetchFn WAS called (invalidated)', async () => {
    const fetch = jest.fn().mockResolvedValue({ name: 'Alice' });
    await cache.get('user:2', fetch);
    await cache.get('user:2', fetch); // promoted

    // Simulate a DB write (update) → invalidate
    cache.invalidate('user:2');

    fetch.mockResolvedValue({ name: 'Alice Updated' });
    const result = await cache.get('user:2', fetch);

    // Must have re-fetched
    expect(fetch).toHaveBeenCalledTimes(3); // 2 promotions + 1 post-invalidation
    expect(result).toEqual({ name: 'Alice Updated' });
  });
});

// ---------------------------------------------------------------------------
//  Stats
// ---------------------------------------------------------------------------

describe('HotKeyCache — stats', () => {
  let cache: HotKeyCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new HotKeyCache({ ...fastOpts, threshold: 2 });
  });

  afterEach(() => {
    cache.destroy();
    jest.useRealTimers();
  });

  it('hitRate is 0 before any requests', () => {
    expect(cache.stats.hitRate).toBe(0);
    expect(cache.stats.totalRequests).toBe(0);
  });

  it('hitRate approaches 1.0 after many repeated reads of same promoted key', async () => {
    const fetch = makeFetch('hot');
    // Promote first (2 misses)
    await cache.get('popular', fetch);
    await cache.get('popular', fetch);

    // Now do 98 cache hits
    for (let i = 0; i < 98; i++) {
      await cache.get('popular', fetch);
    }

    const { hitRate, totalRequests, cacheHits } = cache.stats;
    expect(totalRequests).toBe(100);
    expect(cacheHits).toBe(98);
    expect(hitRate).toBeCloseTo(0.98, 2);
  });
});

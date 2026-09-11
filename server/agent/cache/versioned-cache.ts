/** 有界 TTL/LRU 缓存；版本必须由调用方进入 key，缓存不是事实存储。 */
export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  expiresAt: number;
  version: string;
}

export interface CacheLookup<T> {
  hit: boolean;
  value?: T;
  ageMs?: number;
  version?: string;
}

export class VersionedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number
  ) {}

  get(key: string): CacheLookup<T> {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return { hit: false };
    }
    // Map 末尾视为最近使用。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { hit: true, value: entry.value, ageMs: now - entry.createdAt, version: entry.version };
  }

  set(key: string, value: T, version: string, ttlMs = this.defaultTtlMs): void {
    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, { value, version, createdAt: now, expiresAt: now + ttlMs });
    this.prune(now);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.prune(Date.now());
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}


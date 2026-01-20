/**
 * TTL-based in-memory cache for API responses.
 *
 * Used to reduce API calls to Helius and other external services.
 * Entries automatically expire after their TTL.
 */

/**
 * Internal cache entry structure with expiration tracking.
 */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Generic TTL cache implementation.
 *
 * Features:
 * - Configurable default TTL
 * - Per-entry TTL override
 * - Automatic expiration on access
 * - Periodic cleanup method for memory management
 *
 * @example
 * const cache = new TTLCache<string>(60000); // 1 minute default
 * cache.set('key', 'value');
 * cache.get('key'); // 'value'
 * // After 60 seconds...
 * cache.get('key'); // undefined
 */
class TTLCache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private hits = 0;
  private misses = 0;

  /**
   * Create a new TTL cache.
   * @param defaultTTL - Default time-to-live in milliseconds (default: 60000 = 1 minute)
   */
  constructor(private defaultTTL: number = 60000) {}

  /**
   * Store a value in the cache.
   * @param key - Cache key
   * @param value - Value to store
   * @param ttl - Optional TTL override in milliseconds
   */
  set(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      data: value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL),
    });
  }

  /**
   * Retrieve a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   * Expired entries are automatically deleted on access.
   * @param key - Cache key
   * @returns The cached value or undefined
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry.data;
  }

  /**
   * Check if a key exists and is not expired.
   * @param key - Cache key
   * @returns true if key exists and is valid
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a specific key from the cache.
   * @param key - Cache key to delete
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get the number of entries in the cache (including possibly expired ones).
   * @returns Number of entries
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Remove all expired entries from the cache.
   * Call periodically to prevent memory buildup from expired entries
   * that haven't been accessed.
   * @returns Number of entries removed
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get cache statistics.
   * @returns Object with size, hits, misses, and hit rate
   */
  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }
}

export { TTLCache, CacheEntry };

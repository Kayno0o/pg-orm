// LRU Prepared Statement Cache
// Keyed by query fingerprint (sql string). Parameter values are excluded.

export class PreparedStatementCache {
  private _cache = new Map<string, CacheEntry>()
  private _maxSize: number

  constructor(maxSize = 512) {
    this._maxSize = maxSize
  }

  get(key: string): CacheEntry | undefined {
    const entry = this._cache.get(key)

    if (entry) {
      // LRU: move to end (most recently used)
      this._cache.delete(key)
      this._cache.set(key, entry)
    }

    return entry
  }

  set(key: string, entry: CacheEntry): void {
    if (this._cache.has(key)) {
      this._cache.delete(key)
    }
    else if (this._cache.size >= this._maxSize) {
      // Evict oldest (first key in Map)
      const firstKey = this._cache.keys().next().value

      if (firstKey !== undefined)
        this._cache.delete(firstKey)
    }

    this._cache.set(key, entry)
  }

  invalidateTable(tableName: string): void {
    for (const [key] of this._cache) {
      if (key.includes(tableName)) {
        this._cache.delete(key)
      }
    }
  }

  clear(): void {
    this._cache.clear()
  }

  get size(): number {
    return this._cache.size
  }
}

export interface CacheEntry {
  sql: string
  // We don't cache the bun:sql prepared statement object directly —
  // bun:sql handles its own internal prepared statement cache when
  // the same SQL string is used repeatedly. Our cache is for query
  // fingerprint → SQL string deduplication.
}

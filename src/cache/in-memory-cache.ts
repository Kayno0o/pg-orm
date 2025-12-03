import type { SQLValue } from '../types'

export interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number
}

export interface CacheAdapter {
  get: <T = unknown>(key: string) => Promise<T | null>
  set: <T = unknown>(key: string, value: T, ttl: number) => Promise<void>
  delete: (key: string) => Promise<void>
  clear: () => Promise<void>
  has: (key: string) => Promise<boolean>
}

export class InMemoryCache implements CacheAdapter {
  private cache = new Map<string, CacheEntry>()
  private cleanupInterval?: Timer

  constructor(private cleanupIntervalMs = 60000) {
    this.startCleanup()
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.cache.get(key)

    if (!entry)
      return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)

      return null
    }

    return entry.value as T
  }

  async set<T = unknown>(key: string, value: T, ttl: number): Promise<void> {
    const expiresAt = Date.now() + (ttl * 1000)

    this.cache.set(key, {
      value,
      expiresAt,
    })
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key)
  }

  async clear(): Promise<void> {
    this.cache.clear()
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key)

    if (!entry)
      return false

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)

      return false
    }

    return true
  }

  size(): number {
    return this.cache.size
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()

      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiresAt) {
          this.cache.delete(key)
        }
      }
    }, this.cleanupIntervalMs)

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref()
    }
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = undefined
    }
  }
}

export function hashCacheKey(sql: string, params: SQLValue[]): string {
  const paramsStr = JSON.stringify(params)
  const combined = `${sql}:${paramsStr}`

  return Bun.hash(combined).toString(36)
}

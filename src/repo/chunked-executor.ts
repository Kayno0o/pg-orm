import type { Executable } from '../sql/base-executor'

/**
 * Splits a list of IDs into chunks and runs `buildSql(chunk)` for each,
 * concatenating row results. Empty input returns `[]` without touching the
 * executor. The caller decides the SQL shape (raw IN-clause, JOIN through
 * a pivot, etc.) so the same chunk loop serves every relation strategy.
 */
export class ChunkedQueryExecutor {
  constructor(
    private readonly executor: Executable,
    private readonly chunkSize: number,
  ) {}

  async execute(
    ids: unknown[],
    buildSql: (chunk: unknown[]) => { sql: string, params: unknown[] },
  ): Promise<Record<string, unknown>[]> {
    if (ids.length === 0)
      return []

    if (ids.length <= this.chunkSize) {
      const { sql, params } = buildSql(ids)

      return this.executor.query(sql, params)
    }

    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const chunk = ids.slice(i, i + this.chunkSize)
      const { sql, params } = buildSql(chunk)

      results.push(...await this.executor.query(sql, params))
    }

    return results
  }
}

/** Unique non-null values of `row[key]` across `rows`, in encounter order. */
export function collectParentIds(
  rows: Record<string, unknown>[],
  key: string,
): unknown[] {
  return [...new Set(rows.map(r => r[key]).filter(v => v != null))]
}

/** Last-wins index of `rows` by `row[key]`. */
export function indexBy<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
): Map<unknown, T> {
  const out = new Map<unknown, T>()

  for (const row of rows) out.set(row[key], row)

  return out
}

/** Group `rows` by `row[key]`, preserving insertion order within each bucket. */
export function groupBy<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
): Map<unknown, T[]> {
  const out = new Map<unknown, T[]>()

  for (const row of rows) {
    const k = row[key]
    const bucket = out.get(k)

    if (bucket)
      bucket.push(row)
    else out.set(k, [row])
  }

  return out
}

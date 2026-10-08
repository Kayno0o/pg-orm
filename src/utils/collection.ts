// Pure collection helpers used by relation loading and bulk operations.
// Module-scoped, no state — safe to import anywhere.

/** Unique non-null values of `row[key]` across `rows`, in encounter order. */
export function collectParentIds(
  rows: Record<string, unknown>[],
  key: string,
): unknown[] {
  return [...new Set(rows.map(r => r[key]).filter(v => v != null))]
}

/** A join key two sides compare equal on whatever their numeric type: an int8 read raw as a string, a mapped bigint and an int4 number all meet. */
export function relationKey(value: unknown): unknown {
  return typeof value === 'bigint' || typeof value === 'number' ? String(value) : value
}

/** Last-wins index of `rows` by `relationKey(row[key])`. */
export function indexBy<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
): Map<unknown, T> {
  const out = new Map<unknown, T>()

  for (const row of rows) out.set(relationKey(row[key]), row)

  return out
}

/** Group `rows` by `relationKey(row[key])`, preserving insertion order within each bucket. */
export function groupBy<T extends Record<string, unknown>>(
  rows: T[],
  key: string,
): Map<unknown, T[]> {
  const out = new Map<unknown, T[]>()

  for (const row of rows) {
    const k = relationKey(row[key])
    const bucket = out.get(k)

    if (bucket)
      bucket.push(row)
    else out.set(k, [row])
  }

  return out
}

const JSON_PARAM = Symbol.for('pg-orm.jsonParam')

export interface JsonParam { [JSON_PARAM]: true, value: unknown }

/**
 * Marks a value as bound to a `json`/`jsonb` column, so parameter serialization hands it to
 * the driver untouched.
 *
 * Two encodings are wrong for a JSON column and this is what stands between them. A plain JS
 * array would be turned into a PostgreSQL array literal (`{a,b}`), which is not JSON at all;
 * and a value pre-stringified by the caller arrives as a *string*, which the driver encodes a
 * second time and stores as a JSON string scalar - `jsonb_typeof` answers `string`, `->`
 * finds nothing and `jsonb_array_length` raises. Both round-trip through the ORM unnoticed,
 * because reading parses whatever it is handed back.
 *
 * The write pipeline applies this to json columns on its own. It is exported for callers
 * building statements through `repo.write.insert()` and friends, which take a table name
 * rather than its columns and so cannot know which values are JSON.
 *
 * @example
 * ```ts
 * repo.write.insert().many(rows.map(r => ({ tags: jsonParam(r.tags) }))).toSQL()
 * ```
 */
export function jsonParam(value: unknown): JsonParam {
  return { [JSON_PARAM]: true, value }
}

export function isJsonParam(value: unknown): value is JsonParam {
  return typeof value === 'object' && value !== null && JSON_PARAM in value
}

/** A `JSON.stringify` replacer writing a bigint, which JSON has no form for, as its decimal string. */
export function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** The hex form Postgres reads a `bytea` from, `\x0102`: what a byte array element is written as in an array literal and, on SQLite, in an array's JSON text. */
export function byteaHex(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')}`
}

/** A `JSON.stringify` replacer for an array column's JSON text on SQLite: a bigint as its decimal string, a byte array as its `\x` hex. */
export function arrayElementAsJson(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key]

  return raw instanceof Uint8Array ? byteaHex(raw) : bigintAsString(key, value)
}

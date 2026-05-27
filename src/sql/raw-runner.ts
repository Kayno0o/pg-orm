export type QueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>

/**
 * Owns the `raw()` overloads — tagged-template and plain-string. The tagged
 * form assembles `$N` placeholders inline; the plain form passes through to
 * the underlying query function as-is. The SQL skeleton is sent verbatim;
 * security relies on the caller not assembling it from user input.
 */
export class RawRunner {
  constructor(private readonly queryFn: QueryFn) {}

  run<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  run<T = unknown>(sqlStr: string, params?: unknown[]): Promise<T[]>
  async run<T = unknown>(
    sqlOrStrings: string | TemplateStringsArray,
    ...rest: unknown[]
  ): Promise<T[]> {
    if (typeof sqlOrStrings === 'string') {
      return await this.queryFn(sqlOrStrings, rest[0] as unknown[] ?? []) as T[]
    }

    const parts = sqlOrStrings
    let sql = parts[0] ?? ''
    const params: unknown[] = []

    for (let i = 0; i < rest.length; i++) {
      params.push(rest[i])
      sql += `$${i + 1}${parts[i + 1] ?? ''}`
    }

    return await this.queryFn(sql, params) as T[]
  }
}

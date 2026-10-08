import { ValidationError } from '../errors/index'

export const PLACEHOLDER_RE = /\$(\d+)/g

// `?` binds the next param and `??` is a literal `?`, for the jsonb `?`, `?|` and `?&` operators.
const RAW_PARAM_RE = /\?\??/g

// A quoted literal or identifier, whose `$1` or `?` is text rather than a placeholder.
const QUOTED_RE = /'[^']*(?:''[^']*)*'|"[^"]*(?:""[^"]*)*"/g

/** `sql` with `re` replaced only outside quoted literals and identifiers. */
export function replaceOutsideQuotes(sql: string, re: RegExp, fn: (match: string, ...groups: string[]) => string): string {
  let out = ''
  let last = 0

  for (const m of sql.matchAll(QUOTED_RE)) {
    out += sql.slice(last, m.index).replace(re, fn) + m[0]
    last = m.index + m[0].length
  }

  return out + sql.slice(last).replace(re, fn)
}

/** The `$N` placeholders of `sql` renumbered past `offset`, any inside quotes left alone. */
export function shiftPlaceholders(sql: string, offset: number): string {
  return offset === 0 ? sql : replaceOutsideQuotes(sql, PLACEHOLDER_RE, (_, n) => `$${Number(n) + offset}`)
}

/** The numbers of the `$N` placeholders `sql` uses outside quotes. */
export function placeholderNumbers(sql: string): number[] {
  const found: number[] = []

  replaceOutsideQuotes(sql, PLACEHOLDER_RE, (match, n) => {
    found.push(Number(n))

    return match
  })

  return found
}

/** Raw SQL with each `?` bound through `bind` to the next of `params`, `??` kept as a literal `?`. */
export function bindRawParams(sql: string, params: unknown[], context: string, bind: (value: unknown) => string): string {
  let next = 0

  return replaceOutsideQuotes(sql, RAW_PARAM_RE, (match) => {
    if (match === '??')
      return '?'

    if (next >= params.length)
      throw new ValidationError(`${context} SQL has more "?" placeholders than parameters (${params.length} provided)`, context)

    return bind(params[next++])
  })
}

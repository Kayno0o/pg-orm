export interface SqliteText {
  /** The SQL with every `$N` placeholder written `?N`. */
  text: string
  /** How many statements it holds, a trigger body counting its inner ones. */
  statements: number
}

const DIGIT_RE = /\d/
const IDENTIFIER_CHAR_RE = /[\w$]/
const SPACE_RE = /\s/

// What a quote opens, and the character closing it.
const CLOSERS: Record<string, string> = { '\'': '\'', '"': '"', '`': '`', '[': ']' }

/**
 * Rewrites pg-orm's `$N` placeholders as `?N`, which SQLite binds by number where it would bind `$N` by order of first appearance, and counts the statements.
 * Literals, quoted identifiers and comments are copied untouched.
 */
export function toSqliteText(sql: string): SqliteText {
  let text = ''
  let statements = 0
  let pending = false
  let i = 0

  while (i < sql.length) {
    const ch = sql[i]!
    const closer = CLOSERS[ch]

    if (closer !== undefined) {
      const end = closingIndex(sql, i + 1, closer)

      text += sql.slice(i, end)
      pending = true
      i = end

      continue
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end

      text += sql.slice(i, stop)
      i = stop

      continue
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2

      text += sql.slice(i, stop)
      i = stop

      continue
    }

    if (ch === '$' && DIGIT_RE.test(sql[i + 1] ?? '') && !IDENTIFIER_CHAR_RE.test(sql[i - 1] ?? '')) {
      text += '?'
      i++

      continue
    }

    if (ch === ';') {
      if (pending)
        statements++

      pending = false
    }
    else if (!SPACE_RE.test(ch)) {
      pending = true
    }

    text += ch
    i++
  }

  return { text, statements: statements + (pending ? 1 : 0) }
}

// The index past the quote closing the one opened before `from`; a doubled closer is an escaped one.
function closingIndex(sql: string, from: number, closer: string): number {
  let i = from

  while (i < sql.length) {
    if (sql[i] === closer) {
      if (closer !== ']' && sql[i + 1] === closer) {
        i += 2

        continue
      }

      return i + 1
    }

    i++
  }

  return sql.length
}

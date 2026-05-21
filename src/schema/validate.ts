import { Buffer } from 'node:buffer'
import { ValidationError } from '../errors/index'

// Column and table name validation — prevents SQL injection via schema definitions
// and ensures safety when names are embedded in JIT-compiled Function() sources.

const IDENTIFIER_RE = /^[a-z_]\w*$/i
const MAX_IDENTIFIER_BYTES = 63

export function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new ValidationError(
      `Invalid ${context} name: "${name}". `
      + 'Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.',
      context,
      { value: name },
    )
  }

  if (Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new ValidationError(
      `Invalid ${context} name: "${name}" exceeds PostgreSQL's ${MAX_IDENTIFIER_BYTES}-byte identifier limit. `
      + 'Longer names are silently truncated by PostgreSQL and may collide with other identifiers.',
      context,
      { value: name },
    )
  }
}

// Allowed PG ts_match languages — prevents injection via language parameter
const TS_LANGUAGES = new Set([
  'simple',
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
])

export function validateTsLanguage(language: string): void {
  if (!TS_LANGUAGES.has(language)) {
    throw new ValidationError(
      `Invalid text search language: "${language}". `
      + 'Must be a known PostgreSQL text search configuration name.',
      'ts_match',
      { value: language },
    )
  }
}

/**
 * Validates a raw SQL fragment used in DDL (partial-index WHERE clauses,
 * and potentially other developer-authored fragments). Rejects fragments
 * containing statement terminators, SQL line comments, or block comments
 * outside string literals. Permissive of legitimate SQL such as
 * `body ILIKE '%foo;%'` (the `;` is inside a literal).
 *
 * This is defense-in-depth: schema definitions are normally developer-authored
 * code, but partial-index predicates are commonly copy-pasted from analytics
 * dashboards, which is the realistic injection path.
 */
export function validateRawSqlFragment(fragment: string, context: string): void {
  let i = 0
  let inSingle = false
  let inDouble = false

  while (i < fragment.length) {
    const c = fragment[i]
    const next = fragment[i + 1]

    if (inSingle) {
      if (c === '\'' && next === '\'') {
        i += 2

        continue
      }

      if (c === '\'') {
        inSingle = false
      }

      i++

      continue
    }

    if (inDouble) {
      if (c === '"' && next === '"') {
        i += 2

        continue
      }

      if (c === '"') {
        inDouble = false
      }

      i++

      continue
    }

    if (c === '\'') {
      inSingle = true
      i++

      continue
    }

    if (c === '"') {
      inDouble = true
      i++

      continue
    }

    if (c === ';') {
      throw new ValidationError(
        `${context}: raw SQL fragment contains ";" outside of a string literal. `
        + 'Statement terminators are not allowed in DDL fragments.',
        context,
        { value: fragment },
      )
    }

    if (c === '-' && next === '-') {
      throw new ValidationError(
        `${context}: raw SQL fragment contains "--" comment outside of a string literal.`,
        context,
        { value: fragment },
      )
    }

    if (c === '/' && next === '*') {
      throw new ValidationError(
        `${context}: raw SQL fragment contains "/*" comment outside of a string literal.`,
        context,
        { value: fragment },
      )
    }

    i++
  }

  if (inSingle || inDouble) {
    throw new ValidationError(
      `${context}: raw SQL fragment has an unterminated string literal.`,
      context,
      { value: fragment },
    )
  }
}

const MIGRATION_NAME_RE = /[^\w-]/g

// Sanitize migration filename — no path traversal
export function sanitizeMigrationName(name: string): string {
  return name.replace(MIGRATION_NAME_RE, '_')
}

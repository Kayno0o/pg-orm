import { Buffer } from 'node:buffer'
import { ValidationError } from '../errors/index'

// Column and table name validation — prevents SQL injection via schema definitions
// and ensures safety when names are embedded in JIT-compiled Function() sources.

const IDENTIFIER_RE = /^[a-z_]\w*$/i
// `__proto__` as a key of the mapper's object literal would set the row's prototype; names wrapped in double underscores are the engine's.
const ENGINE_NAME_RE = /^__\w*__$/
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

  if (ENGINE_NAME_RE.test(name)) {
    throw new ValidationError(
      `Invalid ${context} name: "${name}". Names wrapped in double underscores, such as __proto__, are reserved by JavaScript.`,
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

const INDEX_METHODS = new Set(['btree', 'hash', 'gin', 'gist', 'brin'])
const FK_ACTIONS = new Set(['cascade', 'restrict', 'set null', 'set default', 'no action'])

/** An index access method, interpolated into `CREATE INDEX ... USING`: only the ones Postgres ships pass. */
export function validateIndexMethod(method: string | undefined, context: string): void {
  if (method !== undefined && !INDEX_METHODS.has(method))
    throw new ValidationError(`Invalid index method "${method}" on ${context}: expected one of ${[...INDEX_METHODS].join(', ')}.`, context, { value: method })
}

/** A foreign key's ON DELETE / ON UPDATE action, interpolated into its DDL. */
export function validateFkAction(action: string | undefined, context: string): void {
  if (action !== undefined && !FK_ACTIONS.has(action))
    throw new ValidationError(`Invalid foreign key action "${action}" on ${context}: expected one of ${[...FK_ACTIONS].join(', ')}.`, context, { value: action })
}

/** A length, precision or dimension count written into a type (`varchar(n)`, `vector(n)`): a positive integer, or zero where Postgres takes it (a numeric scale). */
export function validateTypeArg(value: number, context: string, min = 1): void {
  if (!Number.isInteger(value) || value < min)
    throw new ValidationError(`Invalid ${context}: ${String(value)} is not an integer of at least ${min}.`, context, { value })
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

const WORD_CHAR_RE = /\w/
const DOLLAR_TAG_START_RE = /[a-z_]/i

function isStandaloneToken(fragment: string, start: number, end: number): boolean {
  if (start > 0 && WORD_CHAR_RE.test(fragment[start - 1] ?? ''))
    return false

  if (end < fragment.length && WORD_CHAR_RE.test(fragment[end] ?? ''))
    return false

  return true
}

/**
 * Validates a raw SQL fragment used in DDL (partial-index WHERE clauses,
 * and potentially other developer-authored fragments). Rejects fragments
 * containing statement terminators, SQL line comments, or block comments
 * outside string literals. Permissive of legitimate SQL such as
 * `body ILIKE '%foo;%'` (the `;` is inside a literal).
 *
 * Also rejects PG-specific string literal forms (`E'...'`, `U&'...'`, and
 * dollar-quoted `$tag$...$tag$`) — these can hide semicolons and comments
 * that the standard single/double-quote scanner cannot see through, so the
 * conservative choice is to refuse them outright. Use plain `'...'`
 * literals (double the apostrophe to escape) in DDL fragments.
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

    // E'...' escape-string literals (PG extension). Reject — they support
    // backslash escapes the scanner doesn't model, so a malicious payload
    // could embed `\';` and break out.
    if ((c === 'E' || c === 'e') && next === '\'' && isStandaloneToken(fragment, i, i + 1)) {
      throw new ValidationError(
        `${context}: raw SQL fragment contains an E'...' escape string. `
        + 'Use plain \'...\' literals (double the apostrophe to escape) in DDL fragments.',
        context,
        { value: fragment },
      )
    }

    // U&'...' Unicode string literals (PG extension). Reject for the same
    // reason — Unicode-escape syntax can smuggle delimiters the scanner
    // cannot decode.
    if ((c === 'U' || c === 'u') && next === '&' && fragment[i + 2] === '\'' && isStandaloneToken(fragment, i, i + 1)) {
      throw new ValidationError(
        `${context}: raw SQL fragment contains a U&'...' Unicode string literal. `
        + 'Use plain \'...\' literals in DDL fragments.',
        context,
        { value: fragment },
      )
    }

    // Dollar-quoted strings: $$...$$ or $tag$...$tag$. Reject — anything
    // between the delimiters is opaque to the scanner (including `;`, `--`,
    // `/*`), which defeats the whole point of this validator. The tag (if
    // any) must start with a letter or underscore, which excludes parameter
    // placeholders like `$1`.
    if (c === '$') {
      let j = i + 1

      while (j < fragment.length && WORD_CHAR_RE.test(fragment[j] ?? '')) {
        j++
      }

      const tagLen = j - (i + 1)
      const tagStartsValid = tagLen === 0 || DOLLAR_TAG_START_RE.test(fragment[i + 1] ?? '')

      if (tagStartsValid && fragment[j] === '$') {
        throw new ValidationError(
          `${context}: raw SQL fragment contains a dollar-quoted string (${fragment.slice(i, j + 1)}). `
          + 'Use plain \'...\' literals in DDL fragments.',
          context,
          { value: fragment },
        )
      }
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
const MAX_MIGRATION_NAME_BYTES = 100

// Sanitize migration filename — no path traversal, length-bounded.
// A bounded length keeps filenames within filesystem limits (most FS cap at 255
// bytes, but PG's identifier ceiling and timestamp prefixes eat into that) and
// blocks pathological inputs from producing multi-MB filenames.
export function sanitizeMigrationName(name: string): string {
  const sanitized = name.replace(MIGRATION_NAME_RE, '_')

  if (Buffer.byteLength(sanitized, 'utf8') > MAX_MIGRATION_NAME_BYTES) {
    throw new ValidationError(
      `Migration name too long after sanitization (${Buffer.byteLength(sanitized, 'utf8')} bytes, max ${MAX_MIGRATION_NAME_BYTES})`,
      'migration.name',
      { value: `${sanitized.slice(0, 80)}…` },
    )
  }

  return sanitized
}

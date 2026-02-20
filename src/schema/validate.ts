// Column and table name validation — prevents SQL injection via schema definitions
// and ensures safety when names are embedded in JIT-compiled Function() sources.

const IDENTIFIER_RE = /^[a-z_]\w*$/i

export function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid ${context} name: "${name}". `
      + 'Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.',
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
    throw new Error(
      `Invalid text search language: "${language}". `
      + 'Must be a known PostgreSQL text search configuration name.',
    )
  }
}

// Sanitize migration filename — no path traversal
export function sanitizeMigrationName(name: string): string {
  return name.replace(/[^\w-]/g, '_')
}

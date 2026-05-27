// Fixtures matching the shape of real bun:sql PG errors as they reach
// `wrapPgError`. Unit tests build mock errors from this map so that when
// bun:sql's emitted field names change, the integration test
// `tests/integration/error-shapes.test.ts` flags the divergence and ALL unit
// tests update by editing this one file.
//
// Convention notes:
// - `errno` carries the PG error code ("23505" etc.) on bun:sql; `code` is the
//   constant string "ERR_POSTGRES_SERVER_ERROR" for any server-side error.
//   `wrapPgError` prefers `errno`.
// - Field names from bun:sql are short-form: `table`, `constraint`, `column`,
//   `schema`, `detail`, `severity`. Older PG bindings emit long-form
//   (`table_name`, `constraint_name`, `column_name`); the wrapper accepts
//   either. We populate short-form here because that's what bun:sql actually
//   sends today.
// - For some classes (unique violation), `column` is positional ("27") rather
//   than the column name — PG only fills the column name reliably for NOT
//   NULL violations. Don't assume `column` is the offending column name.

export interface PgErrorFixture {
  errno: string
  code?: string
  message: string
  constraint?: string
  table?: string
  column?: string
  detail?: string
  schema?: string
  severity?: string
}

export const PG_ERROR_FIXTURES: Record<string, PgErrorFixture> = {
  // unique_violation
  '23505': {
    errno: '23505',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'duplicate key value violates unique constraint "users_email_key"',
    constraint: 'users_email_key',
    table: 'users',
    detail: 'Key (email)=(alice@example.com) already exists.',
    schema: 'public',
    severity: 'ERROR',
  },
  // foreign_key_violation
  '23503': {
    errno: '23503',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'insert or update on table "posts" violates foreign key constraint "posts_author_fk"',
    constraint: 'posts_author_fk',
    table: 'posts',
    detail: 'Key (authorId)=(999999) is not present in table "users".',
    schema: 'public',
    severity: 'ERROR',
  },
  // not_null_violation — the only class where `column` is the column name string
  '23502': {
    errno: '23502',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'null value in column "name" of relation "users" violates not-null constraint',
    table: 'users',
    column: 'name',
    schema: 'public',
    severity: 'ERROR',
  },
  // check_violation
  '23514': {
    errno: '23514',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'new row for relation "users" violates check constraint "users_age_check"',
    constraint: 'users_age_check',
    table: 'users',
    schema: 'public',
    severity: 'ERROR',
  },
  // deadlock_detected
  '40P01': {
    errno: '40P01',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'deadlock detected',
    severity: 'ERROR',
  },
  // serialization_failure
  '40001': {
    errno: '40001',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'could not serialize access due to concurrent update',
    severity: 'ERROR',
  },
  // query_canceled (statement timeout)
  '57014': {
    errno: '57014',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'canceling statement due to statement timeout',
    severity: 'ERROR',
  },
  // connection_failure
  '08006': {
    errno: '08006',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'connection to server was lost',
    severity: 'ERROR',
  },
  // invalid_text_representation — no table/schema; positional column only.
  '22P02': {
    errno: '22P02',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    message: 'invalid input syntax for type integer: "abc"',
    severity: 'ERROR',
  },
}

/**
 * Build a mock error object that mimics bun:sql's emitted shape for the given
 * PG code. Spreads the fixture onto a real `Error` so `instanceof Error`
 * matches the `wrapPgError` guard.
 */
export function makePgError(code: keyof typeof PG_ERROR_FIXTURES, overrides: Partial<PgErrorFixture> & Record<string, unknown> = {}): Error & PgErrorFixture {
  const fixture = PG_ERROR_FIXTURES[code]

  if (!fixture)
    throw new Error(`Unknown PG fixture code: ${code}`)

  const merged = { ...fixture, ...overrides }
  const err = new Error(merged.message) as Error & PgErrorFixture

  Object.assign(err, merged)

  return err
}

import type { Database } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/db'
import { PG_ERROR_FIXTURES } from '../helpers/pg-error-shapes'

// Cross-validates that the unit-test fixtures in `tests/helpers/pg-error-shapes.ts`
// still match the actual shape bun:sql emits for each PG error code we care
// about. If bun:sql renames a field (e.g., `constraint` → `constraint_name`),
// this test fails with a clear diff so the fixture file is the single place to
// update — every unit test then automatically picks up the new shape.

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })

  try {
    await db.raw('ALTER TABLE "posts" ADD CONSTRAINT "posts_author_fk_shapes" FOREIGN KEY ("authorId") REFERENCES "users" ("id") NOT VALID', [])
  }
  catch { /* already present */ }

  try {
    await db.raw('ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_author_fk_shapes"', [])
  }
  catch { /* */ }

  await db.raw('DELETE FROM "users" WHERE "email" = $1', ['shape-test@example.com'])
  await db.raw('INSERT INTO "users" ("name", "email") VALUES ($1, $2)', ['Seed', 'shape-test@example.com'])
})

afterAll(async () => {
  try {
    await db.raw('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_author_fk_shapes"', [])
  }
  catch { /* */ }

  await db.raw('DELETE FROM "users" WHERE "email" = $1', ['shape-test@example.com'])
  await db.close({ timeout: 5000 })
})

// Capture the raw driver error exactly as bun:sql emits it. `db.raw` wraps via
// `wrapPgError`, so the original is on `.cause`.
async function captureRaw(sql: string, params: unknown[] = []): Promise<Error & Record<string, unknown>> {
  try {
    await db.raw(sql, params)

    throw new Error(`Expected SQL to error: ${sql}`)
  }
  catch (e) {
    const cause = (e as Error & { cause?: unknown }).cause

    if (cause instanceof Error)
      return cause as Error & Record<string, unknown>

    return e as Error & Record<string, unknown>
  }
}

// Asserts that each field declared in the fixture is present on the captured
// raw error. We compare *shape* (field presence), not value, because values
// are data-dependent. Missing a field would silently break the wrap-pg-error
// path that relies on it.
function expectShapeMatchesFixture(code: keyof typeof PG_ERROR_FIXTURES, raw: Error & Record<string, unknown>) {
  const fixture = PG_ERROR_FIXTURES[code]!

  expect(raw.errno).toBe(fixture.errno)

  for (const key of Object.keys(fixture) as (keyof typeof fixture)[]) {
    if (key === 'message' || fixture[key] === undefined)
      continue

    expect(
      raw[key as string],
      `Expected raw PG error for ${code} to have field "${key}" (fixture declares it). Got: ${JSON.stringify(Object.keys(raw))}`,
    ).toBeDefined()
  }
}

describe('PG error shape cross-validation', () => {
  it('23505 unique_violation matches fixture shape', async () => {
    const raw = await captureRaw(
      'INSERT INTO "users" ("name", "email") VALUES ($1, $2)',
      ['Dup', 'shape-test@example.com'],
    )

    expectShapeMatchesFixture('23505', raw)
  })

  it('23503 foreign_key_violation matches fixture shape', async () => {
    const raw = await captureRaw(
      'INSERT INTO "posts" ("title", "body", "authorId") VALUES ($1, $2, $3)',
      ['t', 'b', 999999],
    )

    expectShapeMatchesFixture('23503', raw)
  })

  it('23502 not_null_violation matches fixture shape (column = column name)', async () => {
    const raw = await captureRaw(
      'INSERT INTO "users" ("name", "email") VALUES ($1, $2)',
      [null, 'nn-shape@example.com'],
    )

    expectShapeMatchesFixture('23502', raw)
    // NOT NULL is the one class where `column` is the column-name string
    // rather than a positional index. Lock this contract explicitly.
    expect(raw.column).toBe('name')
  })

  it('23514 check_violation matches fixture shape', async () => {
    try {
      await db.raw('CREATE TABLE IF NOT EXISTS "shape_check_test" ("id" serial PRIMARY KEY, "n" int4 CHECK ("n" > 0))', [])

      const raw = await captureRaw(
        'INSERT INTO "shape_check_test" ("n") VALUES ($1)',
        [-1],
      )

      expectShapeMatchesFixture('23514', raw)
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "shape_check_test"', [])
    }
  })

  it('22P02 invalid_text_representation matches fixture shape', async () => {
    const raw = await captureRaw('SELECT $1::int', ['not-a-number'])

    expectShapeMatchesFixture('22P02', raw)
  })

  it('57014 query_canceled (statement timeout) matches fixture shape', async () => {
    // SET LOCAL only takes effect inside a transaction; the bun:sql connection
    // pool resets session state between top-level queries, so a transaction is
    // the only reliable way to scope the timeout.
    let raw: (Error & Record<string, unknown>) | null = null

    try {
      await db.transaction(async (tx) => {
        await tx.query('SET LOCAL statement_timeout = 1', [])

        try {
          await tx.query('SELECT pg_sleep(0.5)', [])
        }
        catch (e) {
          const cause = (e as Error & { cause?: unknown }).cause

          raw = (cause instanceof Error ? cause : e) as Error & Record<string, unknown>

          throw e
        }
      })
    }
    catch {
      // Transaction propagates the cancel error — expected. The raw error was
      // captured inside the tx callback.
    }

    expect(raw, 'statement_timeout did not fire').toBeTruthy()
    expectShapeMatchesFixture('57014', raw!)
  })
})

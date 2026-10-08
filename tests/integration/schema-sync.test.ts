import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { introspectLiveSchema } from '../../src/migration/introspect'
import { TEST_URL } from '../helpers/db'

const SCHEMA = 'pgorm_app'

const accounts = defineTable('accounts', t => ({
  id: t.serial().primaryKey(),
  email: t.text().unique(),
  mood: t.enum('pgorm_app_mood', ['calm', 'busy']),
  pair_a: t.int4(),
  pair_b: t.int4(),
}))

let admin: Database

beforeAll(async () => {
  admin = new Database({ url: TEST_URL })
  await admin.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await admin.raw(`CREATE SCHEMA "${SCHEMA}"`)
})

afterAll(async () => {
  await admin.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await admin.raw('DROP TABLE IF EXISTS "accounts"')
  await admin.close()
})

describe('sync() on a non-public schema', () => {
  it('creates everything in the schema and finds nothing to do the second time', async () => {
    const db = new Database({ url: TEST_URL, schema: SCHEMA, tables: [accounts] })

    try {
      await db.sync()

      expect((await db.raw<{ found: string | null }>(`SELECT to_regclass('"${SCHEMA}"."accounts"')::text AS found`))[0]!.found).toBe(`${SCHEMA}.accounts`)
      expect((await db.raw<{ found: string | null }>(`SELECT to_regclass('public.accounts')::text AS found`))[0]!.found).toBeNull()
      expect((await db.raw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'pgorm_app_mood' AND n.nspname = '${SCHEMA}'`))[0]!.n).toBe(1)
      expect((await db.raw<{ found: string | null }>(`SELECT to_regclass('"${SCHEMA}"."_pgorm_migrations"')::text AS found`))[0]!.found).not.toBeNull()

      expect((await db.sync()).ops).toEqual([])
    }
    finally {
      await db.close()
    }
  })

  it('ignores views, and reads composite uniques and same-named constraints of other schemas right', async () => {
    await admin.raw(`CREATE VIEW "${SCHEMA}"."accounts_view" AS SELECT id FROM "${SCHEMA}"."accounts"`)
    await admin.raw(`ALTER TABLE "${SCHEMA}"."accounts" ADD CONSTRAINT "accounts_pair_key" UNIQUE ("pair_a", "pair_b")`)
    // A public table of the same name whose key and constraint names collide with the schema's.
    await admin.raw('CREATE TABLE "accounts" ("pair_a" int4, "id" int4, CONSTRAINT "accounts_pkey" PRIMARY KEY ("pair_a"), CONSTRAINT "accounts_email_key" UNIQUE ("id"))')

    const live = await introspectLiveSchema(admin, SCHEMA)
    const table = live.tables.find(t => t.name === 'accounts')!

    expect(live.tables.map(t => t.name)).not.toContain('accounts_view')
    expect(table.columns.filter(c => c.isPrimaryKey).map(c => c.name)).toEqual(['id'])
    expect(table.columns.filter(c => c.isUnique).map(c => c.name)).toEqual(['email'])

    const db = new Database({ url: TEST_URL, schema: SCHEMA, tables: [accounts] })

    try {
      expect((await db.sync({ dryRun: true })).ops.map(o => o.description)).toEqual([])
    }
    finally {
      await db.close()
    }
  })
})

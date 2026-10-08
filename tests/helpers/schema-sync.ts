import type { AnyTableDef } from '../../src/index'
import { afterAll, beforeEach } from 'bun:test'
import { Database } from '../../src/index'
import { TEST_URL } from './db'

/** A schema of its own, emptied before each test, so each sync sees only the tables a test moves through. */
export function syncSchemaHarness(schema: string) {
  const admin = new Database({ url: TEST_URL })

  beforeEach(async () => {
    await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.raw(`CREATE SCHEMA "${schema}"`)
  })

  afterAll(async () => {
    await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.close()
  })

  // Opens the schema with one version of its tables, runs `fn` and closes it.
  async function at<T>(tables: AnyTableDef[], fn: (db: Database) => Promise<T>): Promise<T> {
    const db = new Database({ url: TEST_URL, schema, tables })

    try {
      return await fn(db)
    }
    finally {
      await db.close()
    }
  }

  function sync(tables: AnyTableDef[], allowDestructive = false) {
    return at(tables, db => db.sync({ allowDestructive }))
  }

  function constraints(table: string, type: 'f' | 'p' | 'u'): Promise<{ name: string, columns: string[] }[]> {
    return admin.raw<{ name: string, columns: string[] }>(`
      SELECT c.conname AS name, array_agg(a.attname ORDER BY a.attname) AS columns
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = '"${schema}"."${table}"'::regclass AND c.contype = $1
      GROUP BY c.conname ORDER BY c.conname
    `, [type])
  }

  return { admin, at, sync, constraints }
}

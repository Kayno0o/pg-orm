import type { AnyTableDef } from '../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable, DestructiveOpError } from '../../src/index'
import { createTestDb } from '../helpers/db'
import { allTables } from '../helpers/fixtures'

// Bundle fixture tables with extra test tables so sync() doesn't try to drop
// fixtures other tests created.
function createSyncDb(extraTables: AnyTableDef[]) {
  return createTestDb({ tables: [...allTables, ...extraTables] })
}

describe('Migration Sync', () => {
  it('syncs from scratch', async () => {
    const table = defineTable('sync_test_fresh', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const db = createSyncDb([table])

    try {
      await db.raw('DROP TABLE IF EXISTS "sync_test_fresh"', [])

      const result = await db.sync({ allowDestructive: true })
      const createOps = result.ops.filter(o => o.type === 'create_table')

      expect(createOps.some(o => o.table === 'sync_test_fresh')).toBe(true)

      // Verify table exists
      const rows = await db.raw<{ count: string }>('SELECT count(*) FROM "sync_test_fresh"', [])

      expect(Number(rows[0]!.count)).toBe(0)
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "sync_test_fresh"', [])
      await db.close({ timeout: 5000 })
    }
  })

  it('dryRun does not apply changes', async () => {
    const table = defineTable('sync_test_dry', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const db = createSyncDb([table])

    try {
      await db.raw('DROP TABLE IF EXISTS "sync_test_dry"', [])

      const result = await db.sync({ dryRun: true, allowDestructive: true })
      const createOps = result.ops.filter(o => o.type === 'create_table' && o.table === 'sync_test_dry')

      expect(createOps.length).toBeGreaterThan(0)

      // Table should NOT exist
      expect(db.raw('SELECT 1 FROM "sync_test_dry"', [])).rejects.toThrow()
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "sync_test_dry"', [])
      await db.close({ timeout: 5000 })
    }
  })

  it('no drift when schema matches', async () => {
    const table = defineTable('sync_test_nodrift', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const db = createSyncDb([table])

    try {
      await db.raw('DROP TABLE IF EXISTS "sync_test_nodrift"', [])
      await db.sync({ allowDestructive: true }) // create table

      // Sync again should produce no ops
      const result = await db.sync()

      expect(result.ops).toHaveLength(0)
      expect(result.sql).toBe('')
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "sync_test_nodrift"', [])
      await db.close({ timeout: 5000 })
    }
  })

  it('adds column on schema change', async () => {
    const table1 = defineTable('sync_test_addcol', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const db1 = createSyncDb([table1])

    try {
      await db1.raw('DROP TABLE IF EXISTS "sync_test_addcol"', [])
      await db1.sync({ allowDestructive: true })
      await db1.close({ timeout: 5000 })

      // Phase 2: add email column
      const table2 = defineTable('sync_test_addcol', t => ({
        id: t.serial().primaryKey(),
        name: t.text().notNull(),
        email: t.text().nullable(),
      }))
      const db2 = createSyncDb([table2])

      try {
        const result = await db2.sync({ allowDestructive: true })

        expect(result.ops.some(o => o.type === 'add_column' && o.column === 'email')).toBe(true)
      }
      finally {
        await db2.raw('DROP TABLE IF EXISTS "sync_test_addcol"', [])
        await db2.close({ timeout: 5000 })
      }
    }
    catch {
      try {
        await db1.raw('DROP TABLE IF EXISTS "sync_test_addcol"', [])
      }
      catch { /* ignore */ }

      try {
        await db1.close({ timeout: 5000 })
      }
      catch { /* ignore */ }
    }
  })

  it('destructive ops blocked by default', async () => {
    const table = defineTable('sync_test_destruct', t => ({
      id: t.serial().primaryKey(),
    }))
    const db1 = createSyncDb([table])

    try {
      await db1.raw('DROP TABLE IF EXISTS "sync_test_destruct"', [])
      // Create with extra column
      await db1.raw('CREATE TABLE "sync_test_destruct" ("id" serial PRIMARY KEY, "old_col" text)', [])

      expect(db1.sync()).rejects.toThrow(DestructiveOpError)
    }
    finally {
      await db1.raw('DROP TABLE IF EXISTS "sync_test_destruct"', [])
      await db1.close({ timeout: 5000 })
    }
  })

  it('destructive ops allowed with flag', async () => {
    const table = defineTable('sync_test_destruct2', t => ({
      id: t.serial().primaryKey(),
    }))
    const db1 = createSyncDb([table])

    try {
      await db1.raw('DROP TABLE IF EXISTS "sync_test_destruct2"', [])
      // Create with extra column
      await db1.raw('CREATE TABLE "sync_test_destruct2" ("id" serial PRIMARY KEY, "old_col" text)', [])

      const result = await db1.sync({ allowDestructive: true })

      expect(result.ops.some(o => o.destructive)).toBe(true)
    }
    finally {
      await db1.raw('DROP TABLE IF EXISTS "sync_test_destruct2"', [])
      await db1.close({ timeout: 5000 })
    }
  })

  it('sync returns generated SQL', async () => {
    const table = defineTable('sync_test_sql', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const db = createSyncDb([table])

    try {
      await db.raw('DROP TABLE IF EXISTS "sync_test_sql"', [])

      const result = await db.sync({ allowDestructive: true })

      expect(result.sql).toContain('CREATE TABLE')
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "sync_test_sql"', [])
      await db.close({ timeout: 5000 })
    }
  })

  it('syncs tables declared in FK-violating order on empty DB', async () => {
    // Reproduction: child table declared BEFORE parent. Under inline-FK CREATE TABLE
    // this failed with: relation "sync_fk_parent" does not exist.
    const parentRef: { ref?: ReturnType<typeof defineTable> } = {}
    const child = defineTable('sync_fk_child', t => ({
      id: t.serial().primaryKey(),
      parentId: t.integer().notNull().references(() => parentRef.ref!, 'id'),
    }))
    const parent = defineTable('sync_fk_parent', t => ({
      id: t.serial().primaryKey(),
    }))

    parentRef.ref = parent as never

    const db = createSyncDb([child, parent])

    try {
      await db.raw('DROP TABLE IF EXISTS "sync_fk_child"', [])
      await db.raw('DROP TABLE IF EXISTS "sync_fk_parent"', [])

      const result = await db.sync({ allowDestructive: true })

      expect(result.ops.some(o => o.type === 'create_table' && o.table === 'sync_fk_child')).toBe(true)
      expect(result.ops.some(o => o.type === 'create_table' && o.table === 'sync_fk_parent')).toBe(true)
      expect(result.ops.some(o => o.type === 'add_fk' && o.table === 'sync_fk_child')).toBe(true)

      // Verify the FK was actually applied
      const fks = await db.raw<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM information_schema.table_constraints
        WHERE table_name = 'sync_fk_child' AND constraint_type = 'FOREIGN KEY'
      `, [])

      expect(Number(fks[0]!.count)).toBe(1)
    }
    finally {
      await db.raw('DROP TABLE IF EXISTS "sync_fk_child"', [])
      await db.raw('DROP TABLE IF EXISTS "sync_fk_parent"', [])
      await db.close({ timeout: 5000 })
    }
  })

  it('getTablesRegistry returns registered tables', async () => {
    const table = defineTable('sync_test_reg', t => ({
      id: t.serial().primaryKey(),
    }))
    const db = createTestDb({ tables: [table] })

    try {
      const registry = db.getTablesRegistry()

      expect(registry.has('sync_test_reg')).toBe(true)
    }
    finally {
      await db.close({ timeout: 5000 })
    }
  })
})

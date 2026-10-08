import { describe, expect, it } from 'bun:test'
import { defineTable, MigrationError } from '../../src/index'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_sync_rollback'
const { admin, at, sync } = syncSchemaHarness(SCHEMA)

async function history(): Promise<{ name: string, direction: string }[]> {
  return admin.raw(`SELECT name, direction FROM "${SCHEMA}"."_pgorm_migrations" ORDER BY id`)
}

async function columns(table: string): Promise<string[]> {
  const rows = await admin.raw<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = $1 ORDER BY ordinal_position`, [table])

  return rows.map(r => r.name)
}

describe('rollback() of sync migrations', () => {
  it('refuses a migration with an irreversible op, running and recording nothing', async () => {
    const v1 = defineTable('notes', t => ({ id: t.serial().primaryKey(), a: t.text(), b: t.text() }))
    const v2 = defineTable('notes', t => ({ id: t.serial().primaryKey(), a: t.text(), c: t.text().nullable() }))

    await sync([v1])
    await sync([v2], true)

    await expect(at([v2], db => db.rollback())).rejects.toThrow(MigrationError)
    expect((await history()).map(m => m.direction)).toEqual(['up', 'up'])
    expect(await columns('notes')).toEqual(['id', 'a', 'c'])
  })

  it('names each sync uniquely, however fast they run, so each rolls back on its own', async () => {
    const versions = [1, 2, 3, 4].map(n => defineTable('grow', t => ({
      id: t.serial().primaryKey(),
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, t.text().nullable()])),
    })))

    for (const version of versions)
      await sync([version])

    const names = (await history()).map(m => m.name)

    expect(new Set(names).size).toBe(4)
    expect((await at([versions[3]!], db => db.rollback(2))).rolledBack).toEqual(names.slice(2).reverse())
    expect((await at([versions[1]!], db => db.rollback(1))).rolledBack).toEqual(names.slice(1, 2))
    expect(await columns('grow')).toEqual(['id', 'c0'])
  })
})

import type { BaseBuilder } from '../../src/builder/base'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, SelectBuilder, SetOperationBuilder } from '../../src/index'
import { createTestDb, useFileDatabase } from '../helpers/db'

await useFileDatabase()

const nodes = defineTable('bsl_nodes', t => ({
  id: t.int4().primaryKey(),
  parent: t.int4().nullable(),
  dept: t.text(),
}))

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-builder-slips-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [nodes] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'slips.db')}`, tables: [nodes] })],
]

describe.each(dialects)('builder slips on %s', (_name, open) => {
  let db: Database

  const run = (builder: BaseBuilder) => {
    const { sql, params } = builder.toSQL(db.dialect)

    return db.raw<Record<string, unknown>>(sql, params)
  }

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "bsl_nodes"')
    await db.repo(nodes).write.insertMany([
      { id: 1, parent: null, dept: 'a' },
      { id: 2, parent: 1, dept: 'a' },
      { id: 3, parent: 2, dept: 'b' },
      { id: 4, parent: null, dept: 'b' },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  it('a recursive CTE built from a union all reads its own rows', async () => {
    const base = new SelectBuilder<any>('bsl_nodes').pick('id').where({ id: 1 })
    const step = new SelectBuilder<any>('bsl_nodes').as('c').pick().computed(e => e.ref('c.id'), 'id').join('tree', 't', e => e.eq('c.parent', e.ref('t.id')))
    const tree = new SelectBuilder<any>('tree').withRecursive('tree', SetOperationBuilder.unionAll(base, step)).orderBy('id')

    expect((await run(tree)).map(r => r.id)).toEqual([1, 2, 3])
  })

  it('having takes an aggregate through raw', async () => {
    const grouped = db.repo(nodes).read.select().groupBy('dept').aggregate(e => ({ total: e.countCol() })).having(e => e.raw('COUNT(*) > ?', 1)).orderBy('dept')

    expect((await run(grouped)).map(r => [r.dept, r.total])).toEqual([['a', 2], ['b', 2]])
    expect(await run(db.repo(nodes).read.select().groupBy('dept').aggregate(e => ({ total: e.countCol() })).having(e => e.raw('COUNT(*) > ?', 2)))).toEqual([])
  })
})

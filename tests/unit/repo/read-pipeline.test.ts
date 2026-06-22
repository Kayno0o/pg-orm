import type { InferEntity } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { setupReadPipeline } from './ops/_helpers'

const virtualTable = defineTable('virtuals', t => ({
  id: t.serial().primaryKey(),
  firstName: t.text().notNull(),
  lastName: t.text().notNull(),
})).withVirtuals({
  fullName: row => `${row.firstName} ${row.lastName}`,
})

const childrenTable = defineTable('children', t => ({
  id: t.bigserial().primaryKey(),
  parentId: t.int4().notNull(),
})).withVirtuals({
  display: row => `child-${row.id}`,
})

const parentsTable = defineTable('parents', t => ({
  id: t.int4().primaryKey(),
})).withRelations(r => ({
  children: r.hasMany<InferEntity<typeof childrenTable>>('children', 'parentId'),
}))

describe('ReadPipeline post-processing', () => {
  it('runs afterSelect hooks on mapped rows', async () => {
    const table = defineTable('hooked', t => ({
      id: t.bigserial().primaryKey(),
    }))

    table.hook('afterSelect', (rows: any[]) => {
      for (const r of rows) {
        r.seenAs = typeof r.id
      }

      return rows
    })

    const { exec, pipeline } = setupReadPipeline(table)

    exec.preset([{ id: '42' }])

    const rows = await pipeline.findMany() as any[]

    expect(rows[0]!.id).toBeTypeOf('bigint')
    expect(rows[0]!.seenAs).toBe('bigint')
  })

  it('installs virtuals on findMany rows', async () => {
    const { exec, pipeline } = setupReadPipeline(virtualTable)

    exec.preset([{ id: 1, firstName: 'Ada', lastName: 'Lovelace' }])

    const rows = await pipeline.findMany() as any[]

    expect(rows[0]!.fullName).toBe('Ada Lovelace')
  })

  it('applies mapper, hooks, and virtuals to eager-loaded child rows', async () => {
    childrenTable.hook('afterSelect', (rows: any[]) => {
      for (const r of rows) {
        r.hooked = true
      }

      return rows
    })

    const registry = new Map<string, any>([['parents', parentsTable], ['children', childrenTable]])
    const { exec, pipeline } = setupReadPipeline(parentsTable, registry)

    exec.preset([{ id: 1 }]) // parents
    exec.preset([{ id: '100', parentId: 1 }]) // children raw (int8 as string from driver)

    const rows = await pipeline.findMany(q => q.include('children')) as any[]

    expect(rows).toHaveLength(1)
    expect(rows[0]!.children).toHaveLength(1)

    const child = rows[0]!.children[0]

    expect(child.id).toBeTypeOf('bigint')
    expect(child.hooked).toBe(true)
    expect(child.display).toBe('child-100')
  })
})

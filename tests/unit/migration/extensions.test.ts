import type { AnyTableDef } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { diffSchema } from '../../../src/migration/index'

const live = (extensions: string[]) => ({ tables: [], enums: [], extensions })

describe('diffExtensions', () => {
  it('creates citext for a citext column, once, and not when it is installed', () => {
    const tables = new Map<string, AnyTableDef>([
      ['a', defineTable('a', t => ({ id: t.int4().primaryKey(), email: t.citext().unique() }))],
      ['b', defineTable('b', t => ({ id: t.int4().primaryKey(), name: t.citext() }))],
    ])

    expect(diffSchema(live([]), tables).filter(o => o.type === 'create_extension').map(o => o.sql)).toEqual(['CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA public'])
    expect(diffSchema(live(['citext']), tables).map(o => o.type)).toEqual(['create_table', 'create_table'])
  })

  it('creates the extension before the table using it, one op per extension', () => {
    const table = defineTable('both', t => ({ id: t.int4().primaryKey(), email: t.citext(), v: t.vector(2) }))
    const ops = diffSchema(live([]), new Map([['both', table]]))

    expect(ops.map(o => o.type)).toEqual(['create_extension', 'create_extension', 'create_table'])
    expect(ops.slice(0, 2).map(o => o.description).sort()).toEqual(['Create extension "citext"', 'Create extension "vector"'])
  })
})

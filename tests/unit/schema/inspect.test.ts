import type { Trait } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { columnBaseType, defineTable, hasTrait, optimisticLock, softDelete, tableMeta, timestamps, traitColumns, writableColumns } from '../../../src/index'

function orderable(column = 'position'): Trait {
  return {
    name: 'orderable',
    columns: t => ({ [column]: t.int4().notNull().default(0) }),
    meta: { orderable: { column } },
  }
}

const posts = defineTable('posts', t => ({
  id: t.serial().primaryKey(),
  title: t.varchar(255).notNull(),
  tags: t.array(t.text()).notNull(),
  slug: t.text().generated('lower(title)'),
}))
  .withTrait(softDelete())
  .withTrait(timestamps())
  .withTrait(optimisticLock())
  .withTrait(orderable())

const bare = defineTable('bare', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

describe('tableMeta', () => {
  it('reads the built-in trait metadata', () => {
    const meta = tableMeta(posts)

    expect(meta.softDelete?.column).toBe('deletedAt')
    expect(meta.optimisticLock?.column).toBe('version')
    expect(meta.timestamps).toEqual({ createdAt: 'createdAt', updatedAt: 'updatedAt' })
  })

  it('leaves the entries undefined on a table with no traits', () => {
    expect(tableMeta(bare).softDelete).toBeUndefined()
  })
})

describe('hasTrait', () => {
  it('reports applied traits, built-in and custom', () => {
    expect(hasTrait(posts, 'softDelete')).toBe(true)
    expect(hasTrait(posts, 'orderable')).toBe(true)
    expect(hasTrait(posts, 'timestamps')).toBe(true)
    expect(hasTrait(bare, 'softDelete')).toBe(false)
  })
})

describe('traitColumns', () => {
  it('reports every trait-added column, custom traits included', () => {
    expect([...traitColumns(posts)].sort()).toEqual(['createdAt', 'deletedAt', 'position', 'updatedAt', 'version'])
  })

  it('is empty for a table with no traits', () => {
    expect(traitColumns(bare).size).toBe(0)
  })
})

describe('writableColumns', () => {
  it('drops the primary key, generated and trait-managed columns', () => {
    expect(writableColumns(posts)).toEqual(['title', 'tags'])
  })

  it('drops the extra columns passed as exclude', () => {
    expect(writableColumns(posts, { exclude: ['tags'] })).toEqual(['title'])
  })
})

describe('columnBaseType', () => {
  it('strips length, precision and the array suffix', () => {
    expect(columnBaseType(posts.columns.title!)).toEqual({ base: 'varchar', isArray: false })
    expect(columnBaseType(posts.columns.tags!)).toEqual({ base: 'text', isArray: true })
    expect(columnBaseType(posts.columns.id!)).toEqual({ base: 'serial', isArray: false })
  })

  it('strips every array suffix of a multi-dimensional array', () => {
    expect(columnBaseType({ ...posts.columns.tags!, pgType: 'int4[][]' })).toEqual({ base: 'int4', isArray: true })
  })
})

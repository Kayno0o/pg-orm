import { describe, expect, it } from 'bun:test'
import { defineTable, softDelete } from '../../../src/index'

describe('defineTable', () => {
  it('creates a table with columns', () => {
    const table = defineTable('test', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    expect(table.name).toBe('test')
    expect(table.columns.id).toBeDefined()
    expect(table.columns.name).toBeDefined()
  })

  it('detects single primary key', () => {
    const table = defineTable('test', t => ({
      id: t.serial().primaryKey(),
      name: t.text(),
    }))

    expect(table.primaryKey).toBe('id')
  })

  it('detects composite primary key', () => {
    const table = defineTable('test', t => ({
      a: t.int4().primaryKey(),
      b: t.int4().primaryKey(),
      name: t.text(),
    }))

    expect(table.primaryKey).toBe('a,b')
  })

  it('refuses a nullable identity column, which Postgres keeps NOT NULL', () => {
    expect(() => defineTable('idn', t => ({ n: t.int4().identity().nullable() }))).toThrow('identity')
    expect(() => defineTable('idn', t => ({ n: t.int4().nullable().identity() }))).toThrow('identity')
    expect(defineTable('idn', t => ({ n: t.int4().identity() })).columns.n).toBeDefined()
  })

  it('records a repeated modifier once, the last default winning', () => {
    const table = defineTable('rep', t => ({ id: t.int4().primaryKey().primaryKey(), n: t.int4().default(1).default(2), s: t.text().unique().unique() }))
    const count = (column: 'id' | 'n' | 's', type: string) => table.columns[column].constraints.filter(c => c.type === type).length

    expect(count('id', 'primary_key')).toBe(1)
    expect(count('n', 'default')).toBe(1)
    expect(table.columns.n.constraints.find(c => c.type === 'default')?.value).toBe('2')
    expect(count('s', 'unique')).toBe(1)
  })

  it('refuses an index or a unique over a column the table does not have', () => {
    const base = () => defineTable('unk', t => ({ id: t.serial().primaryKey(), a: t.text() }))

    // @ts-expect-error a column the table does not have
    expect(() => base().withIndexes([{ columns: ['a', 'missing'] }])).toThrow('missing')
    // @ts-expect-error a column the table does not have
    expect(() => base().withIndexes([{ columns: ['a'], include: ['gone'] }])).toThrow('gone')
    // @ts-expect-error a column the table does not have
    expect(() => base().withUnique(['a', 'nope'])).toThrow('nope')
    expect(base().withIndexes([{ columns: ['a'] }]).indexes).toHaveLength(1)
  })

  it('returns null when no primary key', () => {
    const table = defineTable('test', t => ({
      name: t.text(),
    }))

    expect(table.primaryKey).toBeNull()
  })

  it('validates table name', () => {
    expect(() => defineTable('bad-name', t => ({ id: t.serial() }))).toThrow(/Invalid table name/)
  })

  it('validates column name', () => {
    expect(() => defineTable('test', t => ({ 'bad-col': t.text() }))).toThrow(/Invalid column name/)
  })

  it('creates with inline relations', () => {
    const table = defineTable('posts', t => ({
      id: t.serial().primaryKey(),
      authorId: t.int4().notNull(),
    }), r => ({
      author: r.belongsTo('users', 'authorId'),
    }))

    expect(table.relations.author).toBeDefined()
    expect(table.relations.author.type).toBe('belongsTo')
  })

  it('supports withRelations for two-phase definition', () => {
    const tableRef = defineTable('test', t => ({
      id: t.serial().primaryKey(),
      fk: t.int4(),
    }))

    const table = tableRef.withRelations(r => ({
      parent: r.belongsTo('other', 'fk'),
    }))

    expect(table.relations.parent).toBeDefined()
  })

  it('supports withVirtuals', () => {
    const tableRef = defineTable('test', t => ({
      id: t.serial().primaryKey(),
      firstName: t.text().notNull(),
      lastName: t.text().notNull(),
    }))

    const table = tableRef.withVirtuals({
      fullName: row => `${row.firstName} ${row.lastName}`,
    })

    expect(table.virtuals.fullName).toBeDefined()
  })

  it('supports withTrait', () => {
    const tableRef = defineTable('test', t => ({
      id: t.serial().primaryKey(),
    }))

    const table = tableRef.withTrait(softDelete())

    expect(table.columns.deletedAt).toBeDefined()
    expect(table.meta.softDelete).toBeDefined()
    expect(table.virtuals.isDeleted).toBeDefined()
  })

  it('supports hook registration', () => {
    const table = defineTable('test', t => ({
      id: t.serial().primaryKey(),
      name: t.text(),
    }))

    table.hook('beforeInsert', () => {
      /* noop */
    })

    expect(table.hooks.beforeInsert).toHaveLength(1)
  })
})

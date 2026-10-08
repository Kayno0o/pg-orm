import { describe, expect, it } from 'bun:test'
import { defineTable, ValidationError } from '../../../src/index'

const EVIL = 'a"; DROP TABLE y; --'

describe('every name and value reaching DDL is validated at definition time', () => {
  it('rejects an enum name that is not an identifier', () => {
    expect(() => defineTable('t', t => ({ s: t.enum(EVIL, ['a']) }))).toThrow(ValidationError)
  })

  it('rejects a renamedFrom that is not an identifier', () => {
    expect(() => defineTable('t', t => ({ s: t.text().renamedFrom(EVIL) }))).toThrow(ValidationError)
  })

  it('rejects a referenced column or a foreign key action outside the known set', () => {
    const target = defineTable('target', t => ({ id: t.serial().primaryKey() }))

    expect(() => defineTable('t', t => ({ r: t.int4().references(() => target, EVIL) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ r: t.int4().references(() => target, 'id', { onDelete: 'cascade; drop table y' as 'cascade' }) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ r: t.int4().references(() => target, 'id', { onUpdate: 'nope' as 'cascade' }) }))).toThrow(ValidationError)
  })

  it('rejects an index method outside the known set, on a column or a table index', () => {
    const table = defineTable('t', t => ({ a: t.text() }))

    expect(() => defineTable('t', t => ({ a: t.text().index({ method: 'btree (a); drop table y; --' as 'btree' }) }))).toThrow(ValidationError)
    expect(() => table.withIndexes([{ columns: ['a'], method: 'nope' as 'btree' }])).toThrow(ValidationError)
  })

  it('rejects a table index name or column that is not an identifier', () => {
    const table = defineTable('t', t => ({ a: t.text() }))

    expect(() => table.withIndexes([{ name: EVIL, columns: ['a'] }])).toThrow(ValidationError)
    expect(() => table.withIndexes([{ columns: [EVIL] }])).toThrow(ValidationError)
  })

  it('rejects a type length, precision or dimension that is not a positive integer', () => {
    expect(() => defineTable('t', t => ({ a: t.varchar('10) ; drop table y; --' as unknown as number) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ a: t.char(0) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ a: t.vector(1.5) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ a: t.numeric(10, -1) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ a: t.bit(-1) }))).toThrow(ValidationError)
    expect(() => defineTable('t', t => ({ a: t.varbit(Number.NaN) }))).toThrow(ValidationError)
  })

  it('still accepts valid definitions', () => {
    const target = defineTable('target', t => ({ id: t.serial().primaryKey() }))
    const table = defineTable('t', t => ({
      s: t.enum('mood', ['happy']),
      r: t.int4().references(() => target, 'id', { onDelete: 'set null', onUpdate: 'cascade' }),
      a: t.text().renamedFrom('old_a').index({ method: 'gin' }),
      n: t.numeric(10, 0),
      v: t.vector(3),
    }))

    expect(() => table.withIndexes([{ name: 't_a_s_idx', columns: ['a', 's'], method: 'btree' }])).not.toThrow()
  })
})

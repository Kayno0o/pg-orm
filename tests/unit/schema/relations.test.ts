import type { InferRelationResult } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { createRelationTypes } from '../../../src/schema/relations'

describe('Relations', () => {
  const r = createRelationTypes()

  it('creates belongsTo', () => {
    const rel = r.belongsTo('users', 'authorId')

    expect(rel.type).toBe('belongsTo')
    expect(rel.targetTable).toBe('users')
    expect(rel.foreignKey).toBe('authorId')
  })

  it('creates hasOne', () => {
    const rel = r.hasOne('profiles', 'userId')

    expect(rel.type).toBe('hasOne')
    expect(rel.targetTable).toBe('profiles')
    expect(rel.foreignKey).toBe('userId')
  })

  it('creates hasMany', () => {
    const rel = r.hasMany('posts', 'authorId')

    expect(rel.type).toBe('hasMany')
    expect(rel.targetTable).toBe('posts')
    expect(rel.foreignKey).toBe('authorId')
  })

  it('creates hasManyThrough', () => {
    const rel = r.hasManyThrough('tags', 'post_tags', { from: 'postId', to: 'tagId' })

    expect(rel.type).toBe('hasManyThrough')
    expect(rel.targetTable).toBe('tags')
    expect(rel.throughTable).toBe('post_tags')
    expect(rel.throughFrom).toBe('postId')
    expect(rel.throughTo).toBe('tagId')
  })

  it('validates target table name', () => {
    expect(() => r.belongsTo('bad-table', 'fk')).toThrow(/Invalid/)
  })

  it('validates foreign key name', () => {
    expect(() => r.hasMany('users', 'bad-key')).toThrow(/Invalid/)
  })

  it('validates through table name', () => {
    expect(() => r.hasManyThrough('tags', 'bad-pivot', { from: 'a', to: 'b' })).toThrow(/Invalid/)
  })

  it('validates through from/to names', () => {
    expect(() => r.hasManyThrough('tags', 'pivot', { from: 'bad-from', to: 'b' })).toThrow(/Invalid/)
    expect(() => r.hasManyThrough('tags', 'pivot', { from: 'a', to: 'bad-to' })).toThrow(/Invalid/)
  })

  it('all relations have _kind = relation', () => {
    expect(r.belongsTo('users', 'fk')._kind).toBe('relation')
    expect(r.hasOne('users', 'fk')._kind).toBe('relation')
    expect(r.hasMany('users', 'fk')._kind).toBe('relation')
    expect(r.hasManyThrough('tags', 'pivot', { from: 'a', to: 'b' })._kind).toBe('relation')
  })
})

describe('relations built from a table thunk', () => {
  const r = createRelationTypes()
  const Parent = defineTable('thunk_parent', t => ({ id: t.serial().primaryKey(), name: t.text() }))
  const Child = defineTable('thunk_child', t => ({ id: t.serial().primaryKey(), parent_id: t.int4() }))
  const Pivot = defineTable('thunk_pivot', t => ({ parent_id: t.int4(), child_id: t.int4() }))

  it('reads the target name from the table', () => {
    expect(r.hasMany(() => Child, 'parent_id').targetTable).toBe('thunk_child')
    expect(r.belongsTo(() => Parent, 'parent_id').targetTable).toBe('thunk_parent')

    const through = r.hasManyThrough(() => Child, () => Pivot, { from: 'parent_id', to: 'child_id' })

    expect(through.targetTable).toBe('thunk_child')
    expect(through.throughTable).toBe('thunk_pivot')
  })

  it('does not call the thunk until the name is read, so a not-yet-initialised import is fine', () => {
    let late: typeof Child | undefined
    const rel = r.hasMany(() => late!, 'parent_id')

    late = Child
    expect(rel.targetTable).toBe('thunk_child')
  })

  it('infers the row type and checks the foreign key against the target', () => {
    const rel = r.hasMany(() => Child, 'parent_id')
    const row: NonNullable<typeof rel._result> = { id: 1, parent_id: 2 }

    // @ts-expect-error not a column of the target
    r.hasMany(() => Child, 'nope')

    expect([rel.type, row.parent_id]).toEqual(['hasMany', 2])
  })

  it('types a belongsTo as nullable only when asked', () => {
    const Wired = defineTable('thunk_wired', t => ({ id: t.serial().primaryKey(), parent_id: t.int4() })).withRelations(rel => ({
      parent: rel.belongsTo(() => Parent, 'parent_id'),
      maybe: rel.belongsTo(() => Parent, 'parent_id', { nullable: true }),
    }))
    const parent: InferRelationResult<typeof Wired.relations.parent> = { id: 1, name: 'p' }
    const maybe: InferRelationResult<typeof Wired.relations.maybe> = null

    // @ts-expect-error a non-nullable belongsTo is never null
    const never: InferRelationResult<typeof Wired.relations.parent> = null

    expect([Wired.relations.maybe.targetTable, parent.name, maybe, never]).toEqual(['thunk_parent', 'p', null, null])
  })
})

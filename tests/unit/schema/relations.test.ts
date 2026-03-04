import { describe, expect, it } from 'bun:test'
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

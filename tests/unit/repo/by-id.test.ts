import type { AnyTableDef } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { NotFoundError, ValidationError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { setupReadPipeline, setupWritePipeline } from './ops/_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

const memberships = defineTable('memberships', t => ({
  userId: t.int4().notNull(),
  groupId: t.int4().notNull(),
  role: t.text().notNull(),
}))

// The table builder takes a single primary key, so the composite case is set up the way the runtime reads it.
const compositeMemberships = { ...memberships, primaryKey: 'userId,groupId' } as unknown as AnyTableDef

describe('read by a where object', () => {
  it('findMany applies a where object with no callback', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([{ id: 1, name: 'Alice' }])
    await pipeline.findMany({ name: 'Alice' })

    expect(exec.lastQuery!.sql).toBe('SELECT * FROM "users" WHERE "name" = $1')
    expect(exec.lastQuery!.params).toEqual(['Alice'])
  })

  it('findOne limits a where object to one row', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([{ id: 1, name: 'Alice' }])
    await pipeline.findOne({ name: 'Alice' })

    expect(exec.lastQuery!.sql).toBe('SELECT * FROM "users" WHERE "name" = $1 LIMIT $2')
  })

  it('findMany takes a function as a select callback and a falsy where as no filter', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([])
    exec.preset([])
    await pipeline.findMany(q => q.where(e => e.eq('name', 'Alice')).limit(5))
    expect(exec.queries[0]!.sql).toBe('SELECT * FROM "users" WHERE "name" = $1 LIMIT $2')

    await pipeline.findMany(false)
    expect(exec.queries[1]!.sql).toBe('SELECT * FROM "users"')
  })
})

describe('read by id', () => {
  it('findById filters on the primary key', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([{ id: 1, name: 'Alice' }])
    await pipeline.findById(1)

    expect(exec.lastQuery!.sql).toBe('SELECT * FROM "users" WHERE "id" = $1 LIMIT $2')
    expect(exec.lastQuery!.params).toEqual([1, 1])
  })

  it('findById keeps the callback shaping and still filters on the key', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([{ id: 1 }])
    await pipeline.findById(1, q => q.pick('id'))

    expect(exec.lastQuery!.sql).toBe('SELECT "id" FROM "users" WHERE "id" = $1 LIMIT $2')
  })

  it('findByIdOrThrow throws NotFoundError on a miss', async () => {
    const { pipeline } = setupReadPipeline(users)

    expect(pipeline.findByIdOrThrow(404)).rejects.toThrow(NotFoundError)
  })

  it('existsById asks for one row only', async () => {
    const { exec, pipeline } = setupReadPipeline(users)

    exec.preset([{ _exists: 1 }])

    expect(await pipeline.existsById(1)).toBe(true)
    expect(exec.lastQuery!.sql).toBe('SELECT 1 AS "_exists" FROM "users" WHERE "id" = $1 LIMIT $2')
  })

  it('rejects a bare value for a composite primary key', async () => {
    const { pipeline } = setupReadPipeline(compositeMemberships)

    expect(pipeline.findById(1)).rejects.toThrow(ValidationError)
  })

  it('matches every part of a composite primary key', async () => {
    const { exec, pipeline } = setupReadPipeline(compositeMemberships)

    exec.preset([{ userId: 1, groupId: 2, role: 'owner' }])
    await pipeline.findById({ userId: 1, groupId: 2 })

    expect(exec.lastQuery!.sql).toBe('SELECT * FROM "memberships" WHERE ("userId" = $1 AND "groupId" = $2) LIMIT $3')
    expect(exec.lastQuery!.params).toEqual([1, 2, 1])
  })

  it('rejects a composite key missing a part', async () => {
    const { pipeline } = setupReadPipeline(compositeMemberships)

    expect(pipeline.findById({ userId: 1 })).rejects.toThrow(ValidationError)
  })
})

describe('write by id', () => {
  it('updateById bounds the update with the key alone', async () => {
    const { exec, rt, pipeline } = setupWritePipeline(users)

    exec.preset([{ id: 3 }])
    await pipeline.updateById({ name: 'Bob' }, rt.pkWhere(3) as any, { pk: true })

    expect(exec.lastQuery!.sql).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING "id"')
    expect(exec.lastQuery!.params).toEqual(['Bob', 3])
  })

  it('deleteById bounds the delete with the key alone', async () => {
    const { exec, rt, pipeline } = setupWritePipeline(users)

    exec.preset([{ id: 3 }])
    await pipeline.deleteById(rt.pkWhere(3) as any, { pk: true })

    expect(exec.lastQuery!.sql).toBe('DELETE FROM "users" WHERE "id" = $1 RETURNING "id"')
  })

  it('updateOne and deleteOne reach only the first match by primary key', async () => {
    const { exec, pipeline } = setupWritePipeline(users)

    exec.preset([{ id: 3 }])
    await pipeline.updateOne({ name: 'Bob' }, { name: 'Al' } as any, { pk: true })

    expect(exec.lastQuery!.sql).toBe('UPDATE "users" SET "name" = $1 WHERE ("name" = $2 AND "id" IN (SELECT "id" FROM "users" WHERE "name" = $3 ORDER BY "id" ASC LIMIT $4)) RETURNING "id"')
    expect(exec.lastQuery!.params).toEqual(['Bob', 'Al', 'Al', 1])

    exec.preset([{ id: 3 }])
    await pipeline.deleteOne({ name: 'Al' } as any, { pk: true })

    expect(exec.lastQuery!.sql).toBe('DELETE FROM "users" WHERE ("name" = $1 AND "id" IN (SELECT "id" FROM "users" WHERE "name" = $2 ORDER BY "id" ASC LIMIT $3)) RETURNING "id"')
  })
})

import type { Database } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const teams = defineTable('ir_teams', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
})).withTrait(softDelete())

const members = defineTable('ir_members', t => ({
  id: t.serial().primaryKey(),
  userId: t.int4(),
  teamId: t.int4(),
})).withTrait(softDelete())

const users = defineTable('ir_users', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
})).withRelations(r => ({
  teams: r.hasManyThrough(() => teams, () => members, { from: 'userId', to: 'teamId' }),
}))

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [users, teams, members] })
  await db.sync({ allowDestructive: true })

  const [user] = await db.repo(users).write.insertMany([{ name: 'u' }], { pk: true })
  const [a, b] = await db.repo(teams).write.insertMany([{ name: 'A' }, { name: 'B' }], { pk: true })
  const [, left] = await db.repo(members).write.insertMany([{ userId: user!, teamId: a! }, { userId: user!, teamId: b! }], { pk: true })

  await db.repo(members).write.deleteById(left!)
})

afterAll(async () => {
  await db.close()
})

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

async function teamNames(withTrashed: boolean): Promise<string[]> {
  const [user] = await db.repo(users).read.findMany(q => q.include('teams', teams, t => (withTrashed ? t.withTrashed() : t).orderBy('name')))

  return (user!.teams as { name: string }[]).map(team => team.name)
}

describe('a soft-deleted pivot row', () => {
  it('links nothing in an include, unless withTrashed', async () => {
    expect(await teamNames(false)).toEqual(['A'])
    expect(await teamNames(true)).toEqual(['A', 'B'])
  })

  it('is not counted by withCount, unless withDeleted', async () => {
    const [live] = await db.repo(users).read.findMany(q => q.withCount('teams'))
    const [all] = await db.repo(users).read.findMany(q => q.withCount('teams', { as: 'all', withDeleted: true }))

    expect(live!.teamsCount).toBe(1)
    expect(all!.all).toBe(2)
  })
})

describe('a relation table missing from config.tables', () => {
  for (const [missing, tables] of [['ir_teams', [users, members]], ['ir_members', [users, teams]]] as const) {
    it(`fails an include or withCount, naming ${missing}`, async () => {
      const partial = createTestDb({ tables: [...tables] })

      try {
        for (const read of [() => partial.repo(users).read.findMany(q => q.include('teams')), () => partial.repo(users).read.findMany(q => q.withCount('teams'))]) {
          const error = await rejection(read())

          expect(error).toBeInstanceOf(ValidationError)
          expect((error as Error).message).toContain(`"${missing}"`)
        }
      }
      finally {
        await partial.close()
      }
    })
  }
})

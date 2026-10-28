import type { Database, Trait } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, OrmError, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const tenant: Trait = {
  name: 'tenant',
  scopes: { tenant: (e, ctx) => e.eq('tenantId', ctx.tenantId) },
}

const projects = defineTable('sc_projects', t => ({
  id: t.serial().primaryKey(),
  tenantId: t.int4(),
  ownerId: t.int4(),
  name: t.text(),
  archived: t.boolean().default(false),
})).withTrait(tenant).withTrait(softDelete()).withScope('active', e => e.eq('archived', false))

const owners = defineTable('sc_owners', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
})).withRelations(r => ({
  projects: r.hasMany(() => projects, 'ownerId'),
}))

let db: Database
const ids: Record<string, number> = {}

beforeAll(async () => {
  db = createTestDb({ tables: [owners, projects] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "sc_projects", "sc_owners" RESTART IDENTITY')

  const [owner] = await db.repo(owners).write.insertMany([{ name: 'o' }], { pk: true })
  const rows = await db.repo(projects).write.insertMany([
    { tenantId: 1, ownerId: owner!, name: 'A' },
    { tenantId: 1, ownerId: owner!, name: 'B', archived: true },
    { tenantId: 2, ownerId: owner!, name: 'C' },
  ])

  for (const row of rows)
    ids[row.name] = row.id
})

afterAll(async () => {
  await db.close()
})

function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return db.withContext({ tenantId: 1 }, fn)
}

async function names(rows: Promise<{ name: string }[]>): Promise<string[]> {
  return (await rows).map(row => row.name).sort()
}

async function stored(): Promise<Record<string, { name: string, deletedAt: Date | null }>> {
  const rows = await db.raw<{ id: number, name: string, deletedAt: Date | null }>('SELECT "id", "name", "deletedAt" FROM "sc_projects"')

  return Object.fromEntries(rows.map(row => [row.id, row]))
}

describe('a scope', () => {
  it('filters every read: finds, count, exists, paginate and both streams', async () => {
    await asTenant(async () => {
      const repo = db.repo(projects)
      const streamed: string[] = []

      for await (const row of repo.stream.offset())
        streamed.push(row.name)

      for await (const row of repo.stream.cursor())
        streamed.push(row.name)

      expect(await names(repo.read.findMany())).toEqual(['A'])
      expect(await repo.read.findById(ids.C)).toBeNull()
      expect(await repo.read.count()).toBe(1)
      expect(await repo.read.exists({ name: 'C' })).toBe(false)
      expect((await repo.read.paginate({ page: 1, perPage: 10 })).total).toBe(1)
      expect(streamed).toEqual(['A', 'A'])
    })
  })

  it('filters an include and a withCount on the scoped table', async () => {
    await asTenant(async () => {
      const [owner] = await db.repo(owners).read.findMany(q => q.include('projects').withCount('projects'))

      expect((owner!.projects as { name: string }[]).map(p => p.name)).toEqual(['A'])
      expect(owner!.projectsCount).toBe(1)
    })
  })

  it('is lifted per call by name, on the builder or in the options', async () => {
    await asTenant(async () => {
      const repo = db.repo(projects)

      expect(await names(repo.read.findMany(q => q.withoutScope('active')))).toEqual(['A', 'B'])
      expect(await repo.read.count(undefined, { withoutScopes: ['tenant', 'active'] })).toBe(3)

      const [owner] = await db.repo(owners).read.findMany(q => q.withCount('projects', { withoutScopes: ['tenant'] }))

      expect(owner!.projectsCount).toBe(2)
    })
  })

  it('reading a context value fails a call made outside that context', async () => {
    let error: unknown

    try {
      await db.repo(projects).read.findMany()
    }
    catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(ValidationError)
  })

  it('guards updates, single and per-row, and deletes, soft and forced', async () => {
    await asTenant(async () => {
      const repo = db.repo(projects).write

      expect(await repo.updateMany({ name: 'x' }, { name: 'C' })).toEqual([])
      expect(await repo.updateManyById([{ id: ids.C!, name: 'x' }])).toEqual([])
      expect(await repo.deleteMany({ name: 'C' })).toEqual([])
      expect(await repo.deleteMany({ name: 'B' })).toEqual([])
      expect(await repo.forceDelete({ name: 'C' })).toEqual([])
      expect((await repo.deleteMany({ name: 'B' }, { withoutScopes: ['active'] })).map(row => row.name)).toEqual(['B'])
      expect((await repo.restore({ name: 'B' }, { withoutScopes: ['active'] })).map(row => row.name)).toEqual(['B'])
    })

    const rows = await stored()

    expect(rows[ids.C!]!.name).toBe('C')
    expect(rows[ids.B!]!.deletedAt).toBeNull()
  })

  it('guards the update an upsert makes on a conflicting row', async () => {
    const hijack = await asTenant(async () => db.repo(projects).write.upsertMany([{ id: ids.C!, tenantId: 1, ownerId: 1, name: 'hijack' }], ['id']))

    expect(hijack).toEqual([])
    expect((await stored())[ids.C!]!.name).toBe('C')
  })

  it('cannot be declared twice under one name', () => {
    expect(() => defineTable('sc_twice', t => ({ id: t.serial().primaryKey() })).withScope('x', e => e.isNotNull('id')).withScope('x', e => e.isNotNull('id'))).toThrow(OrmError)
  })
})

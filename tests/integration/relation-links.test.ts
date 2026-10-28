import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, NotFoundError, softDelete, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const rolesDef = defineTable('lk_roles', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
}))

const userRolesDef = defineTable('lk_user_roles', t => ({
  id: t.serial().primaryKey(),
  userId: t.int4(),
  roleId: t.int4(),
  grantedBy: t.int4().nullable(),
})).withTrait(softDelete())

const tagsDef = defineTable('lk_tags', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
})).withTrait(softDelete())

const userTagsDef = defineTable('lk_user_tags', t => ({
  id: t.serial().primaryKey(),
  userId: t.int4(),
  tagId: t.int4(),
}))

const users = defineTable('lk_users', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
})).withRelations(r => ({
  roles: r.hasManyThrough(() => rolesDef, () => userRolesDef, { from: 'userId', to: 'roleId' }),
  tags: r.hasManyThrough(() => tagsDef, () => userTagsDef, { from: 'userId', to: 'tagId' }),
  grants: r.hasMany(() => userRolesDef, 'userId'),
}))

const tables = [users, rolesDef, userRolesDef, tagsDef, userTagsDef]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-links-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, (subset?: typeof tables, defaultLimit?: number) => Database][] = [
  ['postgres', (subset, defaultLimit) => createTestDb({ tables: subset ?? tables, defaultLimit })],
  ['sqlite', (subset, defaultLimit) => new Database({ url: `sqlite://${join(dir, subset ? 'partial.db' : 'links.db')}`, tables: subset ?? tables, defaultLimit })],
]

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work()
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

describe.each(dialects)('hasManyThrough links on %s', (_name, open) => {
  let db: Database
  let user: number
  let r1: number
  let r2: number
  let r3: number

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(async () => {
    for (const table of ['lk_user_roles', 'lk_user_tags', 'lk_roles', 'lk_tags', 'lk_users'])
      await db.raw(`DELETE FROM "${table}"`)

    ;[user] = await db.repo(users).write.insertMany([{ name: 'u' }], { pk: true }) as [number]
    ;[r1, r2, r3] = await db.repo(rolesDef).write.insertMany([{ label: 'a' }, { label: 'b' }, { label: 'c' }], { pk: true }) as [number, number, number]
  })

  async function roleIds(): Promise<number[]> {
    return (await db.repo(userRolesDef).read.findMany({ userId: user })).map(row => row.roleId).sort()
  }

  async function pivotRows(): Promise<{ roleId: number, grantedBy: number | null, deletedAt: Date | null }[]> {
    return db.repo(userRolesDef).read.findMany(q => q.withTrashed().orderBy('roleId'))
  }

  it('attaches the missing links, skipping those already there', async () => {
    const write = db.repo(users).write

    expect(await write.attach(user, 'roles', [r1, r2])).toEqual([r1, r2])
    expect(await write.attach(user, 'roles', [r2, r3])).toEqual([r3])
    expect(await roleIds()).toEqual([r1, r2, r3])
    expect(await pivotRows()).toHaveLength(3)
  })

  it('sets pivot columns, per target over the call\'s', async () => {
    await db.repo(users).write.attach(user, 'roles', [{ id: r1, pivot: { grantedBy: 7 } }, r2], { pivot: { grantedBy: 1 } })

    expect((await pivotRows()).map(row => row.grantedBy)).toEqual([7, 1])
  })

  it('detaches some or every link, a soft-delete pivot trashing them and a plain one deleting them', async () => {
    const write = db.repo(users).write
    const [t1] = await db.repo(tagsDef).write.insertMany([{ label: 'x' }], { pk: true })

    await write.attach(user, 'roles', [r1, r2, r3])
    await write.attach(user, 'tags', [t1!])

    expect(await write.detach(user, 'roles', [r1])).toEqual([r1])
    expect((await write.detach(user, 'roles')).sort()).toEqual([r2, r3])
    expect(await write.detach(user, 'roles', [])).toEqual([])
    expect(await roleIds()).toEqual([])
    expect((await pivotRows()).every(row => row.deletedAt !== null)).toBe(true)
    expect(await write.detach(user, 'tags')).toEqual([t1!])
    expect(await db.raw('SELECT * FROM "lk_user_tags"')).toHaveLength(0)
  })

  it('restores a trashed link instead of inserting it again, with the pivot columns given', async () => {
    const write = db.repo(users).write

    await write.attach(user, 'roles', [r1])
    await write.detach(user, 'roles', [r1])

    expect(await write.attach(user, 'roles', [{ id: r1, pivot: { grantedBy: 3 } }])).toEqual([r1])
    expect(await pivotRows()).toEqual([expect.objectContaining({ roleId: r1, grantedBy: 3, deletedAt: null })])
  })

  it('syncs to exactly the targets given, reporting what changed', async () => {
    const write = db.repo(users).write

    await write.attach(user, 'roles', [r1, r2])

    expect(await write.sync(user, 'roles', [r2, r3])).toEqual({ attached: [r3], detached: [r1] })
    expect(await roleIds()).toEqual([r2, r3])
    expect(await write.sync(user, 'roles', [])).toEqual({ attached: [], detached: expect.arrayContaining([r2, r3]) })
  })

  it('syncs all-or-nothing, and runs inside the caller\'s transaction', async () => {
    const write = db.repo(users).write

    await write.attach(user, 'roles', [r1, r2])

    expect(await rejection(() => write.sync(user, 'roles', [{ id: r3, pivot: { nope: 1 } }]))).toBeInstanceOf(ValidationError)
    expect(await roleIds()).toEqual([r1, r2])

    await rejection(() => db.transaction(async (tx) => {
      await db.repo(users).using(tx).write.attach(user, 'roles', [r3])
      await db.repo(users).using(tx).write.detach(user, 'roles', [r1])

      throw new Error('roll back')
    }))

    expect(await roleIds()).toEqual([r1, r2])
  })

  it('refuses a parent or target key that is not a single value, before writing anything', async () => {
    const write = db.repo(users).write

    await write.attach(user, 'roles', [r1, r2])

    expect(await rejection(() => write.detach(JSON.parse('{"gte":0}'), 'roles'))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => write.sync(JSON.parse('{"gte":0}'), 'roles', []))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => write.attach(user, 'roles', [JSON.parse('{"gte":0}')]))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => write.detach(user, 'roles', [JSON.parse('{"gte":0}')]))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => write.detach(user, 'roles', JSON.parse('{"gte":0}')))).toBeInstanceOf(ValidationError)
    expect(await roleIds()).toEqual([r1, r2])
  })

  it('refuses a parent or a target the scopes hide or that does not exist', async () => {
    const write = db.repo(users).write
    const [t1, t2] = await db.repo(tagsDef).write.insertMany([{ label: 'x' }, { label: 'y' }], { pk: true }) as [number, number]

    await db.repo(tagsDef).write.deleteById(t2)

    expect(await rejection(() => write.attach(user + 1000, 'roles', [r1]))).toBeInstanceOf(NotFoundError)
    expect(await rejection(() => write.detach(user + 1000, 'roles'))).toBeInstanceOf(NotFoundError)
    expect(await rejection(() => write.attach(user, 'tags', [t1, t2]))).toBeInstanceOf(ValidationError)
    expect(await rejection(() => write.sync(user, 'roles', [r1, r3 + 1000]))).toBeInstanceOf(ValidationError)
    expect(await db.raw('SELECT * FROM "lk_user_tags"')).toHaveLength(0)
    expect(await roleIds()).toEqual([])
  })

  it('reads every link whatever the database\'s defaultLimit', async () => {
    const limited = open(undefined, 1)

    try {
      const write = limited.repo(users).write

      await write.attach(user, 'roles', [r1, r2, r3])

      expect(await write.attach(user, 'roles', [r1, r2, r3])).toEqual([])
      expect(await write.sync(user, 'roles', [r1])).toEqual({ attached: [], detached: expect.arrayContaining([r2, r3]) })
      expect(await roleIds()).toEqual([r1])
    }
    finally {
      await limited.close()
    }
  })

  it('refuses a relation that is not hasManyThrough and a pivot missing from config.tables', async () => {
    const partial = open(tables.filter(table => table !== userRolesDef))

    try {
      // @ts-expect-error grants is a hasMany
      expect(await rejection(() => db.repo(users).write.attach(user, 'grants', [1]))).toBeInstanceOf(ValidationError)
      expect(await rejection(() => partial.repo(users).write.attach(user, 'roles', [r1]))).toBeInstanceOf(ValidationError)
    }
    finally {
      await partial.close()
    }
  })
})

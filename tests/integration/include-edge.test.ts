import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, rawExpr, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const groupsDef = defineTable('ie_groups', t => ({
  id: t.bigserial().primaryKey(),
  name: t.text(),
}))

const membershipsDef = defineTable('ie_memberships', t => ({
  id: t.serial().primaryKey(),
  personId: t.bigint(),
  groupId: t.bigint(),
}))

const peopleDef = defineTable('ie_people', t => ({
  id: t.bigserial().primaryKey(),
  name: t.text(),
  managerId: t.bigint().nullable(),
}))

const people = peopleDef.withRelations(r => ({
  manager: r.belongsTo(() => peopleDef, 'managerId'),
  reports: r.hasMany(() => peopleDef, 'managerId'),
  groups: r.hasManyThrough(() => groupsDef, () => membershipsDef, { from: 'personId', to: 'groupId' }),
}))

const pairs = defineTable('ie_pairs', t => ({
  a: t.int4().primaryKey(),
  b: t.int4().primaryKey(),
})).withRelations(r => ({
  people: r.hasMany(() => peopleDef, 'managerId'),
}))

const tables = [people, groupsDef, membershipsDef, pairs]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-include-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'include.db')}`, tables })],
]

describe.each(dialects)('include() on %s', (_name, open) => {
  let db: Database
  let boss: bigint
  let ann: bigint
  let bob: bigint

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    for (const table of ['ie_memberships', 'ie_groups', 'ie_people', 'ie_pairs'])
      await db.raw(`DELETE FROM "${table}"`)

    boss = await db.repo(people).write.insertOne({ name: 'Boss', managerId: null }, { pk: true })
    ann = await db.repo(people).write.insertOne({ name: 'Ann', managerId: boss }, { pk: true })
    bob = await db.repo(people).write.insertOne({ name: 'Bob', managerId: boss }, { pk: true })
    await db.repo(people).write.insertOne({ name: 'Cid', managerId: ann }, { pk: true })

    const [red, blue, green] = await db.repo(groupsDef).write.insertMany([{ name: 'red' }, { name: 'blue' }, { name: 'green' }], { pk: true })

    await db.repo(membershipsDef).write.insertMany([
      { personId: ann, groupId: red! },
      { personId: ann, groupId: blue! },
      { personId: ann, groupId: green! },
      { personId: bob, groupId: blue! },
    ], { pk: true })
  })

  afterAll(async () => {
    await db.close()
  })

  it('stream.offset() loads includes on streamed rows', async () => {
    const managers: (string | undefined)[] = []

    for await (const row of db.repo(people).stream.offset(q => q.include('manager').orderBy('name'), { chunkSize: 2, unsafe: true }))
      managers.push(row.manager?.name)

    expect(managers).toEqual(['Boss', 'Boss', undefined, 'Ann'])
  })

  it('hasManyThrough joins on bigint keys and honours the callback filter and order', async () => {
    const rows = await db.repo(people).read.findMany(q => q
      .include('groups', groupsDef, g => g.where({ name: { neq: 'green' } }).orderBy('name'))
      .where({ id: [ann, bob] })
      .orderBy('name'))

    expect(rows.map(r => r.groups.map(g => g.name))).toEqual([['blue', 'red'], ['blue']])
  })

  it('applies a callback limit per parent, on hasMany and hasManyThrough', async () => {
    const rows = await db.repo(people).read.findMany(q => q
      .include('reports', people, r => r.orderBy('name', 'desc').limit(1))
      .include('groups', groupsDef, g => g.orderBy('name').offset(1).limit(1))
      .where({ id: [boss, ann] })
      .orderBy('name'))

    expect(rows.map(r => [r.name, r.reports.map(c => c.name), r.groups.map(g => g.name)])).toEqual([
      ['Ann', ['Cid'], ['green']],
      ['Boss', ['Bob'], []],
    ])
  })

  it('keeps computed columns of a callback', async () => {
    const [row] = await db.repo(people).read.findMany(q => q
      .include('manager', people, m => m.pick('id', 'name').computedRaw(rawExpr<number>('1 + 1'), 'two'))
      .where({ id: ann }))

    expect(row!.manager).toMatchObject({ name: 'Boss', two: 2 })
  })

  it('follows a finite self-referential chain', async () => {
    const [row] = await db.repo(people).read.findMany(q => q
      .include('manager', people, m => m.include('manager'))
      .where({ name: 'Cid' }))

    expect(row!.manager?.name).toBe('Ann')
    expect(row!.manager?.manager?.name).toBe('Boss')
  })

  it('throws when a pick leaves out the join column', async () => {
    await expect(db.repo(people).read.findMany(q => q.pick('name').include('reports'))).rejects.toThrow(ValidationError)
    await expect(db.repo(people).read.findMany(q => q.include('reports', people, r => r.pick('name')))).rejects.toThrow(ValidationError)
  })

  it('throws a ValidationError on a composite primary key parent', async () => {
    await db.repo(pairs).write.insertOne({ a: 1, b: 2 }, { pk: true })

    await expect(db.repo(pairs).read.findMany(q => q.include('people'))).rejects.toThrow('composite primary key')
  })
})

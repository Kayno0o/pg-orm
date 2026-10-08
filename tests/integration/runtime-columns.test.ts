import type { AnyColumns, AnyRelations, Repository, SelectBuilder } from '../../src/index'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable, isColumn, ValidationError, whereColumn } from '../../src/index'
import { createTestDb } from '../helpers/db'

const teamsDef = defineTable('rc_teams', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
}))

const membersDef = defineTable('rc_members', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  teamId: t.int4(),
}))

const members = membersDef.withRelations(r => ({
  team: r.belongsTo(() => teamsDef, 'teamId'),
}))

const tables = [teamsDef, members]
const dir = mkdtempSync(join(tmpdir(), 'pg-orm-runtime-columns-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'runtime.db')}`, tables })],
]

// Generic code over any table, as a CRUD layer builds it from a request: every name is a runtime string, and nothing is cast.
async function listRows<C extends AnyColumns, R extends AnyRelations>(repo: Repository<C, R>, query: { fields: string[], sort: string, filter: [string, string], include: keyof R & string }) {
  const fields = query.fields.filter(name => isColumn(repo.table, name))
  const shape = <T>(q: SelectBuilder<C, R, T>) => {
    const picked = q.pick(...fields).andWhere(whereColumn(repo.table, query.filter[0], { iContains: query.filter[1] }))

    if (isColumn(repo.table, query.sort))
      picked.orderBy(query.sort, 'desc')

    return picked.include(query.include)
  }

  return repo.read.findMany(shape)
}

// A name only known at runtime, which the types cannot stop.
const runtime = (name: string) => name as 'name'

describe.each(dialects)('runtime column names on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "rc_members"')
    await db.raw('DELETE FROM "rc_teams"')

    const team = await db.repo(teamsDef).write.insertOne({ label: 'Core' })

    await db.repo(members).write.insertMany([
      { name: 'Ann', teamId: team.id },
      { name: 'Bob', teamId: team.id },
      { name: 'Cid', teamId: team.id },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  it('a WHERE on a column the table lacks throws instead of matching every row, and changes nothing', async () => {
    const repo = db.repo(members)

    await expect(repo.write.deleteMany({ [runtime('nme')]: 'nme' })).rejects.toThrow(ValidationError)
    await expect(repo.write.updateMany({ name: 'Zed' }, { [runtime('nme')]: 'nme' })).rejects.toThrow(ValidationError)
    await expect(repo.read.findMany({ [runtime('nme')]: 'nme' })).rejects.toThrow(ValidationError)
    expect((await repo.read.findMany(q => q.orderBy('id'))).map(r => r.name)).toEqual(['Ann', 'Bob', 'Cid'])
  })

  it('an ORDER BY or pick on a column the table lacks throws', async () => {
    await expect(db.repo(members).read.findMany(q => q.orderBy(runtime('nme')))).rejects.toThrow(ValidationError)
    await expect(db.repo(members).read.findMany(q => q.pick(runtime('nme')))).rejects.toThrow(ValidationError)
  })

  it('generic code picks, filters, sorts and includes by runtime names, ignoring a name the table lacks', async () => {
    const rows = await listRows(db.repo(members), { fields: ['id', 'name', 'teamId', 'nope'], sort: 'name', filter: ['name', 'B'], include: 'team' })

    const plain: Record<string, unknown>[] = rows

    expect(plain).toEqual([{ id: expect.any(Number), name: 'Bob', teamId: expect.any(Number), team: { id: expect.any(Number), label: 'Core' } }])
    expect(() => whereColumn(db.repo(members).table, 'nope', 'x')).toThrow(ValidationError)
  })
})

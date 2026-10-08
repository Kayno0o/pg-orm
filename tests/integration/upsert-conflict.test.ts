import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable, optimisticLock, timestamps } from '../../src/index'
import { createTestDb } from '../helpers/db'

const players = defineTable('uc_players', t => ({
  uuid: t.text().primaryKey(),
  name: t.text(),
  sessions: t.int4().default(0),
  observed: t.bigint().default(0n),
  first_seen: t.timestamptz().nullable(),
  last_seen: t.timestamptz().nullable(),
  meta: t.jsonb<{ tag: string }>().nullable(),
  list: t.jsonb<string[]>().nullable(),
})).withTrait(timestamps()).withTrait(optimisticLock())

const kv = defineTable('uc_kv', t => ({
  key: t.text().primaryKey(),
  value: t.text(),
}))

const handles = defineTable('uc_handles', t => ({
  id: t.serial().primaryKey(),
  handle: t.text().unique(),
}))

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [players, kv, handles] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "uc_players", "uc_kv", "uc_handles"')
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

const early = new Date('2026-01-01T00:00:00Z')
const late = new Date('2026-02-01T00:00:00Z')

function closeSession(uuid: string, name: string, seconds: bigint, at: Date) {
  return db.repo(players).write.upsertOne(
    { uuid, name, sessions: 1, observed: seconds, first_seen: at, last_seen: at },
    ['uuid'],
    {
      set: u => ({
        sessions: u.add(u.existing('sessions'), 1),
        observed: u.add(u.existing('observed'), u.excluded('observed')),
        first_seen: u.coalesce(u.existing('first_seen'), u.excluded('first_seen')),
      }),
    },
    { pk: true },
  )
}

describe('upsert set from the existing row', () => {
  it('rolls columns forward from their previous value and copies the other incoming columns', async () => {
    await closeSession('p1', 'Old', 10n, early)
    await closeSession('p1', 'New', 5n, late)

    const row = await db.repo(players).read.findByIdOrThrow('p1')

    expect(row).toMatchObject({ name: 'New', sessions: 2, observed: 15n, first_seen: early, last_seen: late })
  })

  it('copies no incoming column with columns: []', async () => {
    await db.repo(players).write.insertOne({ uuid: 'p1', name: 'Kept', sessions: 3 }, { pk: true })
    await db.repo(players).write.upsertOne({ uuid: 'p1', name: 'Ignored' }, ['uuid'], { columns: [], set: u => ({ sessions: u.sub(u.existing('sessions'), 1) }) }, { pk: true })

    expect(await db.repo(players).read.findByIdOrThrow('p1')).toMatchObject({ name: 'Kept', sessions: 2 })
  })

  it('writes a plain object or array to a json column as a value', async () => {
    await db.repo(players).write.insertOne({ uuid: 'p1', name: 'a' }, { pk: true })
    await db.repo(players).write.upsertOne({ uuid: 'p1', name: 'a' }, ['uuid'], { set: () => ({ meta: { tag: 'x' }, list: ['a', 'b'] }) }, { pk: true })

    expect(await db.repo(players).read.findByIdOrThrow('p1')).toMatchObject({ meta: { tag: 'x' }, list: ['a', 'b'] })
    expect(await db.raw('SELECT jsonb_typeof("meta") AS meta, jsonb_typeof("list") AS list FROM "uc_players"')).toEqual([{ meta: 'object', list: 'array' }])
  })

  it('bumps updatedAt and the version on the updated row, as any update does', async () => {
    await db.repo(players).write.insertOne({ uuid: 'p1', name: 'a' }, { pk: true })
    const before = await db.repo(players).read.findByIdOrThrow('p1')

    await Bun.sleep(5)
    await db.repo(players).write.upsertOne({ uuid: 'p1', name: 'b' }, ['uuid'], undefined, { pk: true })

    const after = await db.repo(players).read.findByIdOrThrow('p1')

    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
    expect(after.version).toBe(before.version + 1)
  })

  it('findOrCreate still leaves the existing row untouched', async () => {
    await db.repo(players).write.insertOne({ uuid: 'p1', name: 'a' }, { pk: true })
    const before = await db.repo(players).read.findByIdOrThrow('p1')

    await Bun.sleep(5)
    await db.repo(players).write.findOrCreate({ uuid: 'p1', name: 'b' }, ['uuid'], { pk: true })

    expect(await db.repo(players).read.findByIdOrThrow('p1')).toEqual(before)
  })

  it('findOrCreate keeps the serial key of the existing row, which EXCLUDED holds the next value of', async () => {
    const id = await db.repo(handles).write.insertOne({ handle: 'ada' }, { pk: true })

    expect(await db.repo(handles).write.findOrCreate({ handle: 'ada' }, ['handle'], { pk: true })).toBe(id)
    expect((await db.repo(handles).read.findMany()).map(r => r.id)).toEqual([id])
  })

  it('rejects an expression of the wrong type at compile time', () => {
    // @ts-expect-error a text column cannot take a number
    const typed = () => db.repo(players).write.upsertOne({ uuid: 'p1', name: 'a' }, ['uuid'], { set: u => ({ name: u.add(u.existing('sessions'), 1) }) }, { pk: true })

    expect(typeof typed).toBe('function')
  })
})

describe('upsert guarded by a where', () => {
  // The artisans-path lease: take the lock when it lapsed or when the caller already holds it.
  function lease(token: string, until: number, now: number) {
    return db.repo(kv).write.upsertOne({ key: 'lock', value: `${token}:${until}` }, ['key'], {
      where: e => e.or(
        e.raw('split_part("uc_kv"."value", \':\', 2)::int8 < ?', now),
        e.startsWith('value', `${token}:`),
      ),
    }, { pk: true })
  }

  it('updates when the guard holds and returns null when it does not', async () => {
    expect(await lease('a', 100, 0)).toBe('lock')
    expect(await lease('b', 200, 50)).toBeNull()
    expect(await lease('a', 300, 50)).toBe('lock')
    expect(await lease('b', 400, 350)).toBe('lock')
    expect((await db.repo(kv).read.findByIdOrThrow('lock')).value).toBe('b:400')
  })

  it('takes the object form, naming the existing row', async () => {
    await db.repo(kv).write.insertMany([{ key: 'k1', value: 'open' }, { key: 'k2', value: 'closed' }], { pk: true })

    const written = await db.repo(kv).write.upsertMany(
      [{ key: 'k1', value: 'new' }, { key: 'k2', value: 'new' }, { key: 'k3', value: 'new' }],
      ['key'],
      { where: { value: 'open' } },
      { pk: true },
    )

    expect([...written].sort()).toEqual(['k1', 'k3'])
    expect((await db.repo(kv).read.findByIdOrThrow('k2')).value).toBe('closed')
  })
})

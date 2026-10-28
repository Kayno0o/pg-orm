import type { Database } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const owners = defineTable('hop_owners', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
}))

const badges = defineTable('hop_badges', t => ({
  id: t.serial().primaryKey(),
  ownerId: t.int4(),
  label: t.text(),
}))

const ownersWithBadge = owners.withRelations(r => ({
  badge: r.hasOne('hop_badges', 'ownerId'),
}))

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [ownersWithBadge, badges] })
  await db.sync({ allowDestructive: true })

  const [owner] = await db.repo(owners).write.insertMany([{ name: 'a' }], { pk: true })

  await db.repo(badges).write.insertMany([{ ownerId: owner!, label: 'first' }, { ownerId: owner!, label: 'second' }])
})

afterAll(async () => {
  await db.close()
})

describe('a hasOne include matching several rows', () => {
  it('takes the one with the lowest primary key', async () => {
    const [owner] = await db.repo(ownersWithBadge).read.findMany(q => q.include('badge'))

    expect((owner!.badge as { label: string }).label).toBe('first')
  })

  it('takes the first in the order the include sets', async () => {
    const [owner] = await db.repo(ownersWithBadge).read.findMany(q => q.include('badge', badges, b => b.orderBy('id', 'desc')))

    expect((owner!.badge as { label: string }).label).toBe('second')
  })
})

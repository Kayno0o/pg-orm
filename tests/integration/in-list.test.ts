import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const things = defineTable('il_things', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
  big: t.int8(),
  at: t.timestamptz(),
  flag: t.bool(),
  note: t.text().nullable(),
}))

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-in-list-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [things] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'in.db')}`, tables: [things] })],
]

const day = (n: number) => new Date(Date.UTC(2026, 0, n))

describe.each(dialects)('IN and NOT IN lists on %s', (_name, open) => {
  let db: Database

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
    await db.raw('DELETE FROM "il_things"')
    await db.repo(things).write.insertMany([
      { label: 'a,b', big: 9007199254740993n, at: day(1), flag: true, note: null },
      { label: 'say "hi"', big: 2n, at: day(2), flag: false, note: 'x' },
      { label: 'plain', big: 3n, at: day(3), flag: true, note: 'y' },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  const labels = (rows: { label: string }[]) => rows.map(r => r.label).sort()

  it('matches text with commas and quotes, bigints past 2^53, dates and booleans', async () => {
    const read = db.repo(things).read

    expect(labels(await read.findMany({ label: ['a,b', 'say "hi"'] }))).toEqual(['a,b', 'say "hi"'])
    expect(labels(await read.findMany({ big: [9007199254740993n] }))).toEqual(['a,b'])
    expect(labels(await read.findMany({ at: { in: [day(2), day(3)] } }))).toEqual(['plain', 'say "hi"'])
    expect(labels(await read.findMany({ flag: [false] }))).toEqual(['say "hi"'])
  })

  it('NOT IN leaves out the listed values, and a null column, as SQL has it', async () => {
    const read = db.repo(things).read

    expect(labels(await read.findMany({ label: { notIn: ['plain'] } }))).toEqual(['a,b', 'say "hi"'])
    expect(labels(await read.findMany({ note: { notIn: ['x'] } }))).toEqual(['plain'])
  })

  it('takes a list longer than the bind-parameter limit', async () => {
    const many = Array.from({ length: 70_000 }, (_, i) => `n${i}`)

    expect(labels(await db.repo(things).read.findMany(q => q.where(e => e.or(e.in('label', many), e.eq('label', 'plain')))))).toEqual(['plain'])
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { createTestDb } from '../helpers/db'

const docs = defineTable('je_docs', t => ({
  id: t.int4().primaryKey(),
  doc: t.jsonb<unknown>(),
}))

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-json-equality-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const dialects: [string, () => Database][] = [
  ['postgres', () => createTestDb({ tables: [docs] })],
  ['sqlite', () => new Database({ url: `sqlite://${join(dir, 'json.db')}`, tables: [docs] })],
]

describe.each(dialects)('json equality on %s', (_name, open) => {
  let db: Database

  const ids = async (where: unknown) => (await db.repo(docs).read.findMany(q => q.where(where as never))).map(row => row.id).sort()

  beforeAll(async () => {
    db = open()
    await db.sync({ allowDestructive: true })
  })

  beforeEach(async () => {
    await db.raw('DELETE FROM "je_docs"')
    await db.repo(docs).write.insertMany([
      { id: 1, doc: [1, 2] },
      { id: 2, doc: 'hello' },
      { id: 3, doc: 5 },
      { id: 4, doc: { a: 1, s: 'x', n: { deep: [true] } } },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  it('compares an array, a string, a number and an object with the stored value', async () => {
    expect(await ids((e: any) => e.eq('doc', [1, 2]))).toEqual([1])
    expect(await ids((e: any) => e.eq('doc', 'hello'))).toEqual([2])
    expect(await ids((e: any) => e.eq('doc', 5))).toEqual([3])
    expect(await ids((e: any) => e.eq('doc', { a: 1, s: 'x', n: { deep: [true] } }))).toEqual([4])
    expect(await ids((e: any) => e.neq('doc', 'hello'))).toEqual([1, 3, 4])
    expect(await ids((e: any) => e.in('doc', ['hello', 5]))).toEqual([2, 3])
  })

  it('takes the same values in the object form', async () => {
    expect(await ids({ doc: { eq: 'hello' } } as never)).toEqual([2])
    expect(await ids({ doc: { eq: [1, 2] } } as never)).toEqual([1])
    expect(await ids({ doc: { neq: 5 } } as never)).toEqual([1, 2, 4])
    expect(await ids({ doc: { a: 1, s: 'x', n: { deep: [true] } } } as never)).toEqual([4])
  })

  it('compares a jsonb subscript with the value stored there', async () => {
    expect(await ids((e: any) => e.eq(e.jsonbSubscript('doc', 'a'), 1))).toEqual([4])
    expect(await ids((e: any) => e.eq(e.jsonbSubscript('doc', 's'), 'x'))).toEqual([4])
    expect(await ids((e: any) => e.eq(e.jsonbSubscript(e.jsonbSubscript('doc', 'n'), 'deep'), [true]))).toEqual([4])
    expect(await ids((e: any) => e.eq(e.jsonbSubscript('doc', 's'), 'y'))).toEqual([])
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { AbortError, Database, defineTable, DialectError, softDelete } from '../../src/index'
import { createTestDb } from '../helpers/db'

const exported = defineTable('copy_exported', t => ({
  id: t.serial().primaryKey(),
  label: t.text(),
  n: t.int4(),
  flag: t.boolean(),
  day: t.date(),
  tags: t.array(t.text()),
  doc: t.jsonb(),
})).withTrait(softDelete())

const LABELS = ['plain', 'it\'s', 'back\\slash', 'x\'); DROP TABLE "copy_exported"; --', 'comma, "quoted"']

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [exported] })
  await db.sync({ allowDestructive: true })
  await db.raw('TRUNCATE "copy_exported" RESTART IDENTITY')
  await db.repo(exported).write.insertMany(LABELS.map((label, i) => ({ label, n: i, flag: i % 2 === 0, day: new Date(`2026-01-0${i + 1}`), tags: [label], doc: { label } })))
  await db.repo(exported).write.deleteMany({ n: 4 })
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('repo.stream.copyTo', () => {
  it('streams the picked columns as CSV with a header, leaving trashed rows out', async () => {
    const csv = await new Response(db.repo(exported).stream.copyTo({ pick: ['n', 'label'] })).text()

    expect(csv).toBe('n,label\n0,plain\n1,it\'s\n2,back\\slash\n3,"x\'); DROP TABLE ""copy_exported""; --"\n')
  })

  it('matches each WHERE value literally, quotes and backslashes included', async () => {
    const repo = db.repo(exported)

    for (const label of LABELS.slice(0, 4)) {
      const csv = await new Response(repo.stream.copyTo({ where: { label, tags: { eq: [label] }, doc: { eq: { label } } }, pick: ['label'], header: false })).text()

      expect(csv.trim()).toBe(label.includes('"') || label.includes(',') ? `"${label.replaceAll('"', '""')}"` : label)
    }

    expect(await repo.read.count()).toBe(4)
  })

  it('matches a LIKE pattern holding a quote and a backslash', async () => {
    const csv = await new Response(db.repo(exported).stream.copyTo({ where: e => e.or(e.contains('label', '\'s'), e.endsWith('label', 'k\\slash')), pick: ['n'], header: false })).text()

    expect(csv).toBe('1\n2\n')
  })

  it('takes the WHERE callback form, typed values and IN lists', async () => {
    const stream = db.repo(exported).stream.copyTo({
      where: e => e.and(e.in('n', [0, 1, 2]), e.eq('flag', true), e.gte('day', new Date('2026-01-01'))),
      pick: ['id'],
      header: false,
    })

    expect(await new Response(stream).text()).toBe('1\n3\n')
  })

  it('includes trashed rows with withTrashed', async () => {
    const csv = await new Response(db.repo(exported).stream.copyTo({ pick: ['n'], header: false, withTrashed: true })).text()

    expect(csv).toBe('0\n1\n2\n3\n4\n')
  })

  it('leaves the connection usable when the stream is cancelled before its end', async () => {
    const reader = db.repo(exported).stream.copyTo({ where: e => e.raw('true'), pick: ['id'] }).getReader()

    await reader.read()
    await reader.cancel()

    expect(await db.repo(exported).read.count()).toBe(4)
  })

  it('errors the stream with AbortError when the signal of db.withSignal aborts', async () => {
    const controller = new AbortController()
    const stream = db.withSignal(controller.signal, async () => db.repo(exported).stream.copyTo({ where: e => e.raw('pg_sleep(5) IS NOT NULL') }))

    setTimeout(() => controller.abort(), 100)

    await expect(new Response(await stream).text()).rejects.toBeInstanceOf(AbortError)
    expect(await db.raw(`SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'COPY%' AND pid <> pg_backend_pid()`)).toEqual([])
  })

  it('is refused on SQLite', async () => {
    const sqlite = new Database({ url: 'sqlite://:memory:', tables: [exported] })

    try {
      expect(() => sqlite.repo(exported).stream.copyTo()).toThrow(DialectError)
    }
    finally {
      await sqlite.close()
    }
  })
})

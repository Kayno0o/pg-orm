import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { AbortError, Database, defineTable, DialectError, UniqueError, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const loaded = defineTable('copy_loaded', t => ({
  id: t.serial().primaryKey(),
  label: t.text().nullable(),
  code: t.text().unique().nullable(),
  n: t.int4().nullable(),
  big: t.int8().nullable(),
  amount: t.numeric().nullable(),
  flag: t.boolean().nullable(),
  at: t.timestamptz().nullable(),
  day: t.date().nullable(),
  doc: t.jsonb().nullable(),
  raw: t.json().nullable(),
  tags: t.array(t.text()).nullable(),
  nums: t.array(t.int4()).nullable(),
  data: t.bytea().nullable(),
  bins: t.array(t.bytea()).nullable(),
  ref: t.uuid().nullable(),
  made: t.timestamptz().defaultRaw('now()'),
  doubled: t.int4().generated('"n" * 2').nullable(),
}))

let db: Database
let hookRuns = 0

beforeAll(async () => {
  loaded.hook('beforeInsert', (row) => {
    hookRuns++

    return row
  })
  db = createTestDb({ tables: [loaded] })
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await db.raw('TRUNCATE "copy_loaded"')
  hookRuns = 0
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
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

async function* rowsOf(count: number, onRow?: (i: number) => void): AsyncGenerator<{ label: string, n: number }> {
  for (let i = 0; i < count; i++) {
    onRow?.(i)
    yield { label: `row ${i}`, n: i }
  }
}

describe('repo.write.copyFrom', () => {
  it('round-trips every column type as insertOne writes it', async () => {
    const repo = db.repo(loaded)
    const row = {
      label: 'tab\there\nnewline \\ backslash \\N not null',
      code: '',
      n: -7,
      big: 9007199254740993n,
      amount: '12.50',
      flag: false,
      at: new Date('2026-01-02T03:04:05.678Z'),
      day: new Date('2026-03-04'),
      doc: { a: [1, 'x\ty'], nested: { b: null } },
      raw: ['json', 'array'],
      tags: ['a,b', 'say "hi"', 'C:\\path', 'NULL', ''],
      nums: [1, 2, 3],
      data: Buffer.from([0, 9, 255]),
      bins: [Buffer.from([1, 2]), Buffer.alloc(0)],
      ref: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
    }

    expect(await repo.write.copyFrom([row])).toBe(1)

    // `code` is unique, so the row written by insertOne leaves it out.
    const inserted = await repo.write.insertOne({ ...row, code: null })
    const [copied] = await repo.read.findMany(q => q.orderBy('id').limit(1))

    const { id: _copiedId, made: _copiedMade, code: _copiedCode, ...copiedRest } = copied!
    const { id: _insertedId, made: _insertedMade, code: _insertedCode, ...insertedRest } = inserted

    expect(copiedRest).toEqual(insertedRest)
    expect(copied!.label).toBe(row.label)
    expect(copied!.code).toBe('')
    expect(copied!.big).toBe(9007199254740993n)
    expect(copied!.doubled).toBe(-14)
  })

  it('writes a JSON string, number and boolean as JSON scalars, and null as SQL NULL', async () => {
    const repo = db.repo(loaded)

    await repo.write.copyFrom([{ n: 1, doc: 'dark' }, { n: 2, doc: 42 }, { n: 3, doc: true }, { n: 4, doc: null }])

    const rows = await db.raw<{ kind: string | null }>('SELECT jsonb_typeof("doc") AS kind FROM "copy_loaded" ORDER BY "n"')

    expect(rows.map(r => r.kind)).toEqual(['string', 'number', 'boolean', null])
  })

  it('streams an async iterable across many writes and resolves to the row count', async () => {
    const repo = db.repo(loaded)

    expect(await repo.write.copyFrom(rowsOf(20_000))).toBe(20_000)
    expect(await repo.read.count()).toBe(20_000)
  })

  it('gives the columns no row sets their DEFAULT and skips hooks', async () => {
    const repo = db.repo(loaded)

    await repo.write.copyFrom([{ label: 'a' }])

    const [row] = await repo.read.findMany()

    expect(row!.made).toBeInstanceOf(Date)
    expect(row!.n).toBeNull()
    expect(hookRuns).toBe(0)
  })

  it('resolves to 0 without a statement for no rows', async () => {
    expect(await db.repo(loaded).write.copyFrom([])).toBe(0)
  })

  it('refuses an unknown column, a generated one and a row setting none, before any statement', async () => {
    const repo = db.repo(loaded)

    for (const row of [{ nope: 1 }, { doubled: 2 }, {}] as never[]) {
      const error = await rejection(repo.write.copyFrom([row]))

      expect(error).toBeInstanceOf(ValidationError)
    }
  })

  it('refuses a later row setting other columns than the first, loading nothing', async () => {
    const repo = db.repo(loaded)
    const extra = await rejection(repo.write.copyFrom([{ label: 'a' }, { label: 'b', n: 2 }]))

    expect(extra).toBeInstanceOf(ValidationError)
    expect((extra as ValidationError).field).toBe('n')
    expect(await rejection(repo.write.copyFrom([{ label: 'a', n: 1 }, { label: 'b' }]))).toBeInstanceOf(ValidationError)
    expect(await rejection(repo.write.copyFrom([{ label: 'a', n: 1 }, { label: 'b', n: undefined }]))).toBeInstanceOf(ValidationError)
    expect(await repo.read.count()).toBe(0)
  })

  it('maps a constraint violation to its typed error and loads nothing', async () => {
    const repo = db.repo(loaded)
    const error = await rejection(repo.write.copyFrom([{ code: 'x' }, { code: 'y' }, { code: 'x' }]))

    expect(error).toBeInstanceOf(UniqueError)
    expect(await repo.read.count()).toBe(0)
  })

  it('rethrows an error the rows throw, loading nothing', async () => {
    const repo = db.repo(loaded)
    const thrown = new Error('source failed')
    const error = await rejection(repo.write.copyFrom(rowsOf(10_000, (i) => {
      if (i === 5_000)
        throw thrown
    })))

    expect(error).toBe(thrown)
    expect(await repo.read.count()).toBe(0)
  })

  it('rolls back with the transaction it runs in', async () => {
    const error = await rejection(db.transaction(async (tx) => {
      expect(await db.repo(loaded).using(tx).write.copyFrom(rowsOf(3))).toBe(3)

      throw new Error('undo')
    }))

    expect((error as Error).message).toBe('undo')
    expect(await db.repo(loaded).read.count()).toBe(0)
  })

  it('stops with AbortError when the signal of db.withSignal aborts mid-stream', async () => {
    const controller = new AbortController()
    const error = await rejection(db.withSignal(controller.signal, () => db.repo(loaded).write.copyFrom(rowsOf(20_000, (i) => {
      if (i === 10_000)
        controller.abort()
    }))))

    expect(error).toBeInstanceOf(AbortError)
    expect(await db.repo(loaded).read.count()).toBe(0)
  })

  it('is refused on SQLite', async () => {
    const sqlite = new Database({ url: 'sqlite://:memory:', tables: [loaded] })

    try {
      expect(await rejection(sqlite.repo(loaded).write.copyFrom([{ label: 'a' }]))).toBeInstanceOf(DialectError)
    }
    finally {
      await sqlite.close()
    }
  })
})

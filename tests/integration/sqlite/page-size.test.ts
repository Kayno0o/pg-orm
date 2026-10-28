import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database, defineTable, ValidationError } from '../../../src/index'

const marks = defineTable('ps_marks', t => ({
  id: t.int4().primaryKey(),
}))

describe('page size cap', () => {
  const capped = new Database({ url: 'sqlite://:memory:', tables: [marks] })
  const tight = new Database({ url: 'sqlite://:memory:', tables: [marks], maxPageSize: 5 })

  beforeAll(async () => {
    for (const db of [capped, tight]) {
      await db.sync()
      await db.repo(marks).write.insertMany(Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 })), { pk: true })
    }
  })

  afterAll(async () => {
    await capped.close()
    await tight.close()
  })

  it('refuses a perPage or take past 1000 by default, and past maxPageSize when set', async () => {
    const read = capped.repo(marks).read

    expect((await read.paginate({ page: 1, perPage: 1000 })).data).toHaveLength(1000)
    await expect(read.paginate({ page: 1, perPage: 1001 })).rejects.toThrow(ValidationError)
    await expect(read.paginateCursor({ take: 100_000_000 })).rejects.toThrow(ValidationError)
    await expect(tight.repo(marks).read.paginate({ page: 1, perPage: 6 })).rejects.toThrow('up to 5')
    await expect(tight.repo(marks).read.paginateCursor({ take: 6 })).rejects.toThrow(ValidationError)
  })

  it('keeps the cap on a repository bound to a transaction', async () => {
    await tight.transaction(async (tx) => {
      await expect(tight.repo(marks).using(tx).read.paginate({ page: 1, perPage: 6 })).rejects.toThrow(ValidationError)
    })
  })

  it('refuses a page whose offset passes the largest safe integer', async () => {
    await expect(capped.repo(marks).read.paginate({ page: 1e15, perPage: 1000 })).rejects.toThrow(ValidationError)
  })

  it('leaves a stream\'s chunk size uncapped', async () => {
    let n = 0

    for await (const _ of tight.repo(marks).stream.cursor({ chunkSize: 2000 }))
      n++

    expect(n).toBe(1500)
  })
})

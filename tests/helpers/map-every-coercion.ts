import { Database, defineTable } from '../../src/index'

const everyCoercion = defineTable('every_coercion', t => ({
  id: t.serial().primaryKey(),
  flag: t.boolean(),
  at: t.timestamptz(),
  amount: t.numeric(),
  doc: t.jsonb(),
  big: t.int8(),
  bigs: t.array(t.int8()),
  times: t.array(t.timestamptz()),
  bins: t.array(t.bytea()),
  tags: t.array(t.text()),
}))

/** Writes one row holding every column type the mapper coerces on SQLite, and reads it back whole, picked and with a computed alias, as one printable string. */
export async function mapEveryCoercion(): Promise<string> {
  const db = new Database({ url: 'sqlite://:memory:', tables: [everyCoercion] })

  try {
    await db.sync()

    const repo = db.repo(everyCoercion)

    await repo.write.insertOne({ flag: true, at: new Date('2026-01-02T03:04:05Z'), amount: '12.50', doc: { a: [1, 'x'] }, big: 9007199254740993n, bigs: [1n, 2n], times: [new Date(0)], bins: [Buffer.from([1, 255])], tags: ['a', 'b'] })

    const whole = await repo.read.findMany()
    const picked = await repo.read.findMany(q => q.pick('flag', 'big', 'bins'))
    const computed = await repo.read.findMany(q => q.pick('id').computedRaw('"id" * 2', 'twice'))

    return Bun.inspect({ whole, picked, computed })
  }
  finally {
    await db.close()
  }
}

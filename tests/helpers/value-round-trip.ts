import type { Database } from '../../src/index'
import { expect, it } from 'bun:test'
import { defineTable } from '../../src/index'

// Values that once came back changed: array elements bound through String(), JSON scalars parsed a second time, int8 arrays left as strings.
export const valuesTable = defineTable('value_round_trip', t => ({
  id: t.serial().primaryKey(),
  times: t.array(t.timestamptz()).nullable(),
  docs: t.array(t.jsonb()).nullable(),
  big: t.array(t.int8()).nullable(),
  doc: t.jsonb().nullable(),
  n: t.int4().nullable(),
}))

/** The round-trip cases, run against `db()` once its table exists. */
export function valueRoundTripCases(db: () => Database): void {
  async function roundTrip(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const repo = db().repo(valuesTable)

    await db().raw('DELETE FROM "value_round_trip"')
    await repo.write.insertOne(row)

    const [read] = await repo.read.findMany()

    return read!
  }

  it('Date, object and bigint array elements round-trip', async () => {
    const row = { times: [new Date(0), new Date('2024-02-29T12:34:56.789Z')], docs: [{ a: 1 }, { b: 'x"y' }], big: [1n, 9007199254740993n] }

    expect(await roundTrip(row)).toMatchObject(row)
  })

  it('JSON string, boolean and number scalars round-trip unchanged', async () => {
    for (const doc of ['123', 'true', 'hello', '{"a":1}', '{1,2}', '{{name}}', true, false, 0, 12.5, { a: [1, 2] }])
      expect((await roundTrip({ doc })).doc).toEqual(doc)
  })

  it('sum, avg and countCol read back as the numbers their type says', async () => {
    const repo = db().repo(valuesTable)

    await db().raw('DELETE FROM "value_round_trip"')
    await repo.write.insertMany([{ n: 1 }, { n: 2 }, { n: null }])

    const [stats] = await repo.read.findMany(q => q.aggregate(e => ({ sum: e.sum('n'), avg: e.avg('n'), count: e.countCol('n'), rows: e.countCol() })))

    expect(stats).toEqual({ sum: 3, avg: 1.5, count: 2, rows: 3 })
  })
}

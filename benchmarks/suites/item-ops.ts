import type { Database } from '../../src/index'
import type { Row } from '../item-schema'
import type { BenchmarkEntry } from '../utils'
import { childRow, freshItems, itemRow, plainItems } from '../item-schema'
import { bench } from '../utils'

export const plainRepo = (db: Database) => db.repo(plainItems)

export type ItemRepo = ReturnType<typeof plainRepo>

export interface ItemOpsEnv {
  /** The repository under test. The rich table's repository is passed typed as the plain one: the ops touch only columns both share. */
  repo: ItemRepo
  rich: boolean
  /** Set when the database is fake, which then needs the rows each op's queries answer. */
  fake?: { answer: (...results: Row[][]) => void }
  /** An id of an existing row that nothing needs again, for the delete benchmark. */
  nextDeleteId: () => number
}

/** The repository operations both the fake-executor and the SQLite suites time. */
export function itemOps(env: ItemOpsEnv): BenchmarkEntry[] {
  const { repo, fake } = env
  const rows = (n: number) => fake ? Array.from({ length: n }, (_, i) => itemRow(i + 1, env.rich)) : []
  const one = rows(1)
  const twenty = rows(20)
  const hundred = rows(100)
  const thousand = rows(1000)
  const page = twenty.map(r => ({ ...r, __pgorm_total: 1000 }))
  const children = fake ? Array.from({ length: 60 }, (_, i) => childRow(i + 1, (i % 20) + 1)) : []
  const answer = (...results: Row[][]) => fake?.answer(...results)
  // A real table grows with each insert, so those benchmarks run a fixed count; a fake one calibrates like any other.
  const mutating = (ops: number) => fake ? undefined : { ops }
  let views = 0

  return [
    bench('findById', async () => {
      answer(one)
      await repo.read.findById(1)
    }),

    bench('findMany.object', async () => {
      answer(one)
      await repo.read.findMany({ email: 'user7@bench.test' })
    }),

    bench('findMany.callback', async () => {
      answer(twenty)
      await repo.read.findMany(q => q.where(e => e.and(e.eq('role', 'admin'), e.gt('views', 900))).limit(20))
    }),

    bench('insertOne', async () => {
      answer(one)
      await repo.write.insertOne(freshItems(1)[0]!)
    }, mutating(200)),

    bench('insertMany.100', async () => {
      answer(hundred)
      await repo.write.insertMany(freshItems(100))
    }, mutating(10)),

    bench('insertMany.1000', async () => {
      answer(thousand)
      await repo.write.insertMany(freshItems(1000))
    }, mutating(2)),

    bench('updateOne', async () => {
      answer(one)
      await repo.write.updateOne({ views: ++views }, { id: 1 })
    }),

    bench('updateById', async () => {
      answer(one)
      await repo.write.updateById(1, { views: ++views })
    }),

    // A real table needs a row per call, which the pool behind `nextDeleteId` holds: 5 warmup runs and 20 samples of 50.
    bench('deleteById', async () => {
      answer(one)
      await repo.write.deleteById(env.nextDeleteId())
    }, mutating(50)),

    bench('paginate', async () => {
      answer(page)
      await repo.read.paginate({ page: 2, perPage: 20 })
    }),

    bench('include.hasMany', async () => {
      answer(twenty, children)
      await repo.read.findMany(q => q.include('children').limit(20))
    }),
  ]
}

import type { Database } from '../../src/index'
import type { ItemRepo } from './item-ops'
import { freshItems, itemChildren, richItems } from '../item-schema'
import { bench, defineSuite } from '../utils'
import { itemOps, plainRepo } from './item-ops'

const SEEDED_ITEMS = 1000
// The delete benchmark runs 5 warmup calls and 20 samples of 50 ops.
const DELETE_POOL = 1100

/** Seeds the items the read and update benchmarks hit, and returns the ids set aside for the delete benchmark. */
async function seedItems(repo: ItemRepo): Promise<number[]> {
  await repo.write.insertMany(Array.from({ length: SEEDED_ITEMS }, (_, i) => ({
    name: `User ${i + 1}`,
    email: `user${i + 1}@bench.test`,
    role: (i + 1) % 5 === 0 ? 'admin' : 'user',
    views: (i + 1) % 1000,
  })), { returning: false })

  return repo.write.insertMany(freshItems(DELETE_POOL), { pk: true })
}

export async function sqliteSuites(db: Database) {
  const plain = plainRepo(db)
  const rich = db.repo(richItems) as unknown as ItemRepo
  const plainPool = await seedItems(plain)
  const richPool = await seedItems(rich)

  await db.repo(itemChildren).write.insertMany(
    Array.from({ length: 600 }, (_, i) => ({ itemId: (i % 200) + 1, label: `Child ${i}` })),
    { returning: false },
  )

  const bulkOps = (repo: ItemRepo) => [
    bench('insertMany.5000', async () => {
      await repo.write.insertMany(freshItems(5000), { returning: false })
    }, { ops: 1 }),

    bench('findMany.inList300', async () => {
      await repo.read.findMany({ id: Array.from({ length: 300 }, (_, i) => i + 1) })
    }),
  ]

  return [
    defineSuite('sqlite-plain', [...itemOps({ repo: plain, rich: false, nextDeleteId: () => plainPool.pop()! }), ...bulkOps(plain)]),
    defineSuite('sqlite-traits', [...itemOps({ repo: rich, rich: true, nextDeleteId: () => richPool.pop()! }), ...bulkOps(rich)]),
  ]
}

import type { Suite } from './utils'
import { Database } from '../src/index'
import { FakeDb } from './fake-db'
import { itemTables } from './item-schema'
import { createDb, seed } from './schema'
import { deleteSuite } from './suites/delete'
import { insertSuite } from './suites/insert'
import { paginationSuite } from './suites/pagination'
import { queryBuilderSuite } from './suites/query-builder'
import { rawSuite } from './suites/raw'
import { relationsSuite } from './suites/relations'
import { repoFakeSuites } from './suites/repo-fake'
import { selectSuite } from './suites/select'
import { sqliteSuites } from './suites/sqlite'
import { updateSuite } from './suites/update'

export interface LoadedTarget {
  suites: Suite[]
  close: () => Promise<void>
}

/** The suite groups `run.ts` can run: each opens what it needs and hands back its suites and how to clean up. */
export const targets: Record<string, () => Promise<LoadedTarget>> = {
  // The repository path on a fake executor: the ORM's own CPU, with no database.
  async repo() {
    const db = new FakeDb()

    return { suites: repoFakeSuites(db), close: () => db.close() }
  },

  // The same operations on a real in-memory SQLite database.
  async sqlite() {
    const db = new Database({ url: 'sqlite://:memory:', tables: itemTables })

    await db.sync()

    return { suites: await sqliteSuites(db), close: () => db.close() }
  },

  // Needs the Postgres of `bun run db:up`.
  async pg() {
    const db = createDb()

    console.log('Seeding database...')
    const counts = await seed(db, 1000, 5, 2)

    console.log(`  ${counts.userCount} users, ${counts.postCount} posts, ${counts.commentCount} comments\n`)

    const raw = rawSuite()

    return {
      suites: [
        raw.suite,
        insertSuite(db),
        selectSuite(db),
        updateSuite(db),
        deleteSuite(db),
        relationsSuite(db),
        queryBuilderSuite(),
        paginationSuite(db),
      ],
      async close() {
        await db.raw`DROP TABLE IF EXISTS bench_comments`
        await db.raw`DROP TABLE IF EXISTS bench_posts`
        await db.raw`DROP TABLE IF EXISTS bench_users`
        await raw.close()
        await db.close()
      },
    }
  },
}

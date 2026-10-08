import { SQL } from 'bun'
import { BENCH_URL } from '../schema'
import { bench, defineSuite } from '../utils'

// The select suite's statements through bun:sql alone: the gap to them is what the ORM adds.
export function rawSuite() {
  const sql = new SQL(BENCH_URL, { max: 5 })
  const live = '"deletedAt" IS NULL'

  return {
    suite: defineSuite('raw', [
      bench('findOne.byPk', async () => {
        await sql.unsafe(`SELECT * FROM "bench_users" WHERE "id" = $1 AND ${live} LIMIT $2`, [1, 1])
      }),

      bench('findMany.where', async () => {
        await sql.unsafe(`SELECT * FROM "bench_users" WHERE "role" = $1 AND ${live} LIMIT $2`, ['admin', 50])
      }),

      bench('count', async () => {
        await sql.unsafe(`SELECT count(*) FROM "bench_users" WHERE ${live}`, [])
      }),

      bench('include.hasMany', async () => {
        const parents = await sql.unsafe(`SELECT * FROM "bench_users" WHERE ${live} LIMIT $1`, [20]) as { id: number }[]

        await sql.unsafe('SELECT * FROM "bench_posts" WHERE "authorId" = ANY($1)', [`{${parents.map(p => p.id).join(',')}}`])
      }),
    ]),
    close: () => sql.close(),
  }
}

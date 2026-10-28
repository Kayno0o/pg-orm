import type { ExprBuilder, ExprTape } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database, defineTable } from '../../src/index'
import { createTestDb, TEST_URL } from '../helpers/db'

// The docker-compose image ships pgvector; a Postgres without it skips these.
const probe = createTestDb({ tables: [] })
const [available] = await probe.raw<{ n: number }>('SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = \'vector\'')

await probe.close()

// A database of its own, so the extension is really absent when the first sync runs.
const VEC_DB = 'pgorm_vec_index'
const vecUrl = TEST_URL.replace(/\/[^/?]+(\?|$)/, `/${VEC_DB}$1`)

interface ItemsOptions {
  method?: 'hnsw' | 'ivfflat'
  opclass?: string
  with?: { m?: number, efConstruction?: number, lists?: number }
  concurrently?: boolean
}

function items(opts: ItemsOptions = {}, table = 'vi_items') {
  return defineTable(table, t => ({
    id: t.int4().primaryKey(),
    embedding: t.vector(3),
  })).withIndexes([{
    name: `${table}_embedding_idx`,
    columns: ['embedding'],
    method: opts.method ?? 'hnsw',
    opclass: { embedding: opts.opclass ?? 'vector_cosine_ops' },
    ...opts.with ? { with: opts.with } : {},
    ...opts.concurrently ? { concurrently: true } : {},
  }])
}

describe.skipIf(!available?.n)('vector indexes on pgvector', () => {
  const admin = new Database({ url: TEST_URL })
  const opened: Database[] = []

  function open(tables: ReturnType<typeof items>[], extra: { onQuery?: (e: { sql: string }) => void } = {}) {
    const db = new Database({ url: vecUrl, tables, ...extra })

    opened.push(db)

    return db
  }

  async function indexDef(db: Database, table = 'vi_items'): Promise<string | undefined> {
    const [row] = await db.raw<{ def: string }>('SELECT indexdef AS def FROM pg_indexes WHERE indexname = $1', [`${table}_embedding_idx`])

    return row?.def.slice(row.def.indexOf(' USING '))
  }

  beforeAll(async () => {
    await admin.raw(`DROP DATABASE IF EXISTS ${VEC_DB} WITH (FORCE)`)
    await admin.raw(`CREATE DATABASE ${VEC_DB}`)
  })

  afterAll(async () => {
    for (const db of opened)
      await db.close()

    await admin.raw(`DROP DATABASE IF EXISTS ${VEC_DB} WITH (FORCE)`)
    await admin.close()
  })

  it('creates the vector extension itself, then a sync is a no-op', async () => {
    const db = open([items()])
    const first = await db.sync({ allowDestructive: true })

    expect(first.ops[0]?.type).toBe('create_extension')
    expect(first.sql).toContain('CREATE EXTENSION IF NOT EXISTS "vector"')
    expect((await db.raw<{ n: number }>('SELECT count(*)::int AS n FROM pg_extension WHERE extname = \'vector\''))[0]?.n).toBe(1)
    expect(await indexDef(db)).toBe(' USING hnsw (embedding vector_cosine_ops)')
    expect((await db.sync()).ops).toEqual([])
  })

  it('emits the parameters as WITH and recreates the index when the method, opclass or a parameter changes', async () => {
    const steps: [ReturnType<typeof items>, string][] = [
      [items({ with: { m: 8, efConstruction: 32 } }), ' USING hnsw (embedding vector_cosine_ops) WITH (m=\'8\', ef_construction=\'32\')'],
      [items({ with: { m: 8, efConstruction: 40 } }), ' USING hnsw (embedding vector_cosine_ops) WITH (m=\'8\', ef_construction=\'40\')'],
      [items({ opclass: 'vector_l2_ops', with: { m: 8, efConstruction: 40 } }), ' USING hnsw (embedding vector_l2_ops) WITH (m=\'8\', ef_construction=\'40\')'],
      [items({ method: 'ivfflat', opclass: 'vector_ip_ops', with: { lists: 10 } }), ' USING ivfflat (embedding vector_ip_ops) WITH (lists=\'10\')'],
    ]

    for (const [table, expected] of steps) {
      const next = open([table])
      const { ops } = await next.sync({ allowDestructive: true })

      expect(ops.map(o => o.type)).toEqual(['drop_index', 'create_index'])
      expect(await indexDef(next)).toBe(expected)
      expect((await next.sync()).ops).toEqual([])
    }
  })

  it('builds a concurrent vector index on an existing table outside the transaction', async () => {
    const plain = defineTable('vi_conc', t => ({ id: t.int4().primaryKey(), embedding: t.vector(3) }))

    await open([plain]).sync({ allowDestructive: true })

    const db = open([items({ concurrently: true }, 'vi_conc')])
    const { ops } = await db.sync()

    expect(ops.map(o => [o.type, o.outsideTransaction])).toEqual([['create_index', true]])
    expect(await indexDef(db, 'vi_conc')).toBe(' USING hnsw (embedding vector_cosine_ops)')
    expect((await db.sync()).ops).toEqual([])
  })

  it('serves an ordered top-k query from the index', async () => {
    const table = items({}, 'vi_topk')
    const db = open([table])

    await db.sync({ allowDestructive: true })
    await db.raw('INSERT INTO "vi_topk" SELECT g, ARRAY[random(), random(), random()]::vector FROM generate_series(1, 500) g')
    await db.raw('ANALYZE "vi_topk"')

    const { sql, params } = db.repo(table).read.select().orderBy(e => e.vectorCosineDistance('embedding', [1, 0, 0])).limit(5).toSQL()
    const plan = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off', [])

      return tx.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)
    })
    const text = JSON.stringify(plan)

    expect(text).toContain('vi_topk_embedding_idx')
    expect(text).not.toContain('Seq Scan')
  })

  it('runs a query with its search settings in one transaction, which end with it', async () => {
    const table = items({}, 'vi_topk')
    const queries: string[] = []
    const db = open([table], { onQuery: e => queries.push(e.sql) })
    const repo = db.repo(table)
    const nearest = (search: Parameters<ReturnType<typeof repo.read.select>['vectorSearch']>[0]) => repo.read.findMany(q => q.orderBy(e => e.vectorCosineDistance('embedding', [1, 0, 0])).limit(3).computedRaw('current_setting(\'hnsw.ef_search\', true)', 'ef').vectorSearch(search))

    // The setting is read by the query itself, so it only shows when both statements ran in one transaction.
    const rows = await nearest({ efSearch: 77, iterativeScan: 'relaxed_order', maxScanTuples: 5000 })

    expect(rows).toHaveLength(3)
    expect(rows[0]?.ef).toBe('77')
    expect(queries.filter(s => s.includes('set_config'))).toHaveLength(1)
    expect(await nearest({ probes: 3 })).toHaveLength(3)

    const seen = await db.transaction(async (tx) => {
      const inside = await repo.using(tx).read.findMany(q => q.limit(1).vectorSearch({ efSearch: 123 }))
      const [setting] = await tx.query('SELECT current_setting(\'hnsw.ef_search\') AS v', [])

      return { inside, setting: setting?.v }
    })

    expect(seen.inside).toHaveLength(1)
    expect(seen.setting).toBe('123')
    expect((await db.raw<{ v: string | null }>('SELECT current_setting(\'hnsw.ef_search\', true) AS v'))[0]?.v).not.toBe('123')
  })
})

describe.skipIf(!available?.n)('halfvec, sparsevec, binary vectors and L1', () => {
  const docs = defineTable('vt_docs', t => ({
    id: t.int4().primaryKey(),
    half: t.halfvec(3),
    sparse: t.sparsevec(4),
    bits: t.bit(4),
    full: t.vector(3),
  }))
  const db = createTestDb({ tables: [docs] })

  beforeAll(async () => {
    await db.sync({ allowDestructive: true })
    await db.raw('DELETE FROM "vt_docs"')
  })

  afterAll(async () => {
    await db.raw('DROP TABLE IF EXISTS "vt_docs"')
    await db.close()
  })

  it('round-trips each type', async () => {
    const written = await db.repo(docs).write.insertMany([
      { id: 1, half: [1, 0, 0], sparse: '{1:1,3:2}/4', bits: '1010', full: [1, 0, 0] },
      { id: 2, half: [0, 1, 0], sparse: '{2:1}/4', bits: '0101', full: [0, 1, 0] },
      { id: 3, half: [0.5, 0.5, 0], sparse: '{1:1}/4', bits: '1000', full: [0.5, 0.5, 0] },
    ])

    expect(written[0]).toEqual({ id: 1, half: [1, 0, 0], sparse: '{1:1,3:2}/4', bits: '1010', full: [1, 0, 0] })
    expect((await db.repo(docs).read.findById(3))?.half).toEqual([0.5, 0.5, 0])
  })

  it('orders by every distance', async () => {
    const order = async (cb: (e: ExprBuilder<any>) => ExprTape) => {
      const rows = await db.repo(docs).read.findMany(q => q.pick('id').orderBy(cb).orderBy('id'))

      return rows.map(r => r.id)
    }

    expect(await order(e => e.vectorCosineDistance('half', [1, 0, 0], 'halfvec'))).toEqual([1, 3, 2])
    expect(await order(e => e.vectorL2Distance('half', [1, 0, 0], 'halfvec'))).toEqual([1, 3, 2])
    expect(await order(e => e.vectorInnerProduct('half', [1, 0, 0], 'halfvec'))).toEqual([1, 3, 2])
    expect(await order(e => e.vectorL1Distance('full', [1, 0, 0]))).toEqual([1, 3, 2])
    expect(await order(e => e.vectorL1Distance('half', [1, 0, 0], 'halfvec'))).toEqual([1, 3, 2])
    expect(await order(e => e.vectorL2Distance('sparse', '{1:1}/4'))).toEqual([3, 2, 1])
    expect(await order(e => e.bitHammingDistance('bits', '1010'))).toEqual([1, 3, 2])
    expect(await order(e => e.bitJaccardDistance('bits', '1010'))).toEqual([1, 3, 2])
  })
})

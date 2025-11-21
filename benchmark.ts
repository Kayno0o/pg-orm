import { orm, timestamps } from './src'

// ============================================================================
// Benchmark Configuration
// ============================================================================

const ITERATIONS = 100
const BULK_SIZES = [100, 500, 1000]
const WARMUP_ITERATIONS = 10

// ============================================================================
// Test Entity
// ============================================================================

const BenchUser = orm
  .entity('bench_users', {
    name: orm.string(),
    email: orm.string().unique(),
    age: orm.number().nullable(),
    role: orm.enum(['admin', 'user', 'moderator'] as const),
    isActive: orm.boolean().default(true),
    metadata: orm.jsonb<{ score: number, tags: string[] }>().nullable(),
    tags: orm.array('string'),
  })
  .use(timestamps())
  .build()

// ============================================================================
// Benchmark Utilities
// ============================================================================

interface BenchResult {
  name: string
  iterations: number
  totalMs: number
  avgMs: number
  minMs: number
  maxMs: number
  opsPerSec: number
}

async function benchmark(name: string, iterations: number, fn: () => Promise<void>): Promise<BenchResult> {
  const times: number[] = []

  for (let i = 0; i < iterations; i++) {
    const start = performance.now()

    await fn()
    times.push(performance.now() - start)
  }

  const totalMs = times.reduce((a, b) => a + b, 0)
  const avgMs = totalMs / iterations
  const minMs = Math.min(...times)
  const maxMs = Math.max(...times)
  const opsPerSec = 1000 / avgMs

  return { name, iterations, totalMs, avgMs, minMs, maxMs, opsPerSec }
}

function formatResult(r: BenchResult): string {
  return `${r.name.padEnd(40)} ${r.opsPerSec.toFixed(1).padStart(10)} ops/s | avg: ${r.avgMs.toFixed(3).padStart(8)}ms | min: ${r.minMs.toFixed(3).padStart(8)}ms | max: ${r.maxMs.toFixed(3).padStart(8)}ms`
}

function printSection(title: string) {
  console.log(`\n${'='.repeat(100)}`)
  console.log(`  ${title}`)
  console.log('='.repeat(100))
}

// ============================================================================
// Main Benchmark
// ============================================================================

async function main() {
  console.log('PostgreSQL ORM Benchmark')
  console.log('========================\n')

  // Connect
  await orm.connect({
    connectionString: process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/orm_test',
    migrations: { autoMigrate: true, noInteraction: true },
  })

  const db = orm.getDB()

  await db`DROP TABLE IF EXISTS bench_users CASCADE`
  await db`
    CREATE TABLE bench_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER,
      role TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      metadata JSONB,
      tags TEXT[] NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `

  const users = orm.repo(BenchUser)
  const results: BenchResult[] = []

  // Warmup
  console.log('Warming up...')
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    const u = await users.create({ name: `warmup${i}`, email: `warmup${i}@test.com`, role: 'user', tags: [] })

    await users.find(u.id)
    await users.delete(u.id)
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  printSection('CRUD Operations')

  let testId = 0

  // Insert
  results.push(await benchmark('create() - single insert', ITERATIONS, async () => {
    testId++
    await users.create({ name: `user${testId}`, email: `user${testId}@test.com`, role: 'user', tags: ['test'] })
  }))
  console.log(formatResult(results[results.length - 1]))

  // Get all IDs for read/update/delete tests
  const allUsers = await users.findAll()
  const ids = allUsers.map(u => u.id)

  // Select by ID
  let idIdx = 0

  results.push(await benchmark('find() - select by ID', ITERATIONS, async () => {
    await users.find(ids[idIdx % ids.length])
    idIdx++
  }))
  console.log(formatResult(results[results.length - 1]))

  // Update
  let updateIdx = 0

  results.push(await benchmark('update() - single update', ITERATIONS, async () => {
    await users.update(ids[updateIdx % ids.length], { age: updateIdx })
    updateIdx++
  }))
  console.log(formatResult(results[results.length - 1]))

  // Delete
  const toDelete = await users.createMany(
    Array.from({ length: ITERATIONS }, (_, i) => ({
      name: `delete${i}`,
      email: `delete${i}@test.com`,
      role: 'user' as const,
      tags: [],
    })),
  )
  let delIdx = 0

  results.push(await benchmark('delete() - single delete', ITERATIONS, async () => {
    await users.delete(toDelete[delIdx].id)
    delIdx++
  }))
  console.log(formatResult(results[results.length - 1]))

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  printSection('Bulk Operations')

  for (const size of BULK_SIZES) {
    // Clean up
    await db`TRUNCATE bench_users RESTART IDENTITY`

    const bulkData = Array.from({ length: size }, (_, i) => ({
      name: `bulk${i}`,
      email: `bulk${i}@test.com`,
      role: 'user' as const,
      tags: ['bulk'],
    }))

    results.push(await benchmark(`createMany() - ${size} records`, 5, async () => {
      await db`TRUNCATE bench_users RESTART IDENTITY`
      await users.createMany(bulkData)
    }))
    console.log(formatResult(results[results.length - 1]))
  }

  // Pagination
  await db`TRUNCATE bench_users RESTART IDENTITY`
  await users.createMany(
    Array.from({ length: 1000 }, (_, i) => ({
      name: `page${i}`,
      email: `page${i}@test.com`,
      role: i % 3 === 0 ? 'admin' as const : 'user' as const,
      tags: ['paging'],
    })),
  )

  results.push(await benchmark('paginate() - page of 20', ITERATIONS, async () => {
    await users.paginate({ page: 1, pageSize: 20 })
  }))
  console.log(formatResult(results[results.length - 1]))

  results.push(await benchmark('paginate() - page of 100', ITERATIONS, async () => {
    await users.paginate({ page: 1, pageSize: 100 })
  }))
  console.log(formatResult(results[results.length - 1]))

  // ============================================================================
  // Query Builder
  // ============================================================================

  printSection('Query Builder')

  results.push(await benchmark('findBy() - simple where', ITERATIONS, async () => {
    await users.findBy({ where: { role: 'admin' } })
  }))
  console.log(formatResult(results[results.length - 1]))

  results.push(await benchmark('findBy() - where + order + limit', ITERATIONS, async () => {
    await users.findBy({ where: { role: 'user' }, order: { name: 'ASC' }, limit: 10 })
  }))
  console.log(formatResult(results[results.length - 1]))

  results.push(await benchmark('query().where().orderBy().limit()', ITERATIONS, async () => {
    await users.query().where('role', '=', 'user').orderBy('name', 'ASC').limit(10).execute()
  }))
  console.log(formatResult(results[results.length - 1]))

  results.push(await benchmark('query().whereIn()', ITERATIONS, async () => {
    await users.query().whereIn('role', ['admin', 'moderator']).execute()
  }))
  console.log(formatResult(results[results.length - 1]))

  results.push(await benchmark('count()', ITERATIONS, async () => {
    await users.count({ where: { role: 'admin' } })
  }))
  console.log(formatResult(results[results.length - 1]))

  // ============================================================================
  // Summary
  // ============================================================================

  printSection('Summary')
  console.log('\nAll Results (sorted by ops/sec):\n')
  results
    .sort((a, b) => b.opsPerSec - a.opsPerSec)

  for (const result of results)
    console.log(formatResult(result))

  // Cleanup
  await db`DROP TABLE IF EXISTS bench_users`
  await orm.disconnect()

  console.log('\nBenchmark complete!')
}

try {
  main()
}
catch (e) {
  console.error(e)
}

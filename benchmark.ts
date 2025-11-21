import Benchmark from 'benchmark'
import { orm, timestamps } from './src'

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

  // Warmup
  console.log('Warming up...')
  for (let i = 0; i < 10; i++) {
    const u = await users.create({ name: `warmup${i}`, email: `warmup${i}@test.com`, role: 'user', tags: [] })

    await users.find(u.id)
    await users.delete(u.id)
  }

  // Prepare test data
  await db`TRUNCATE bench_users RESTART IDENTITY`
  const testUsers = await users.createMany(
    Array.from({ length: 100 }, (_, i) => ({
      name: `user${i}`,
      email: `user${i}@test.com`,
      role: (i % 3 === 0 ? 'admin' : 'user') as 'admin' | 'user',
      tags: ['test'],
    })),
  )
  const ids = testUsers.map(u => u.id)

  let createIdx = 1000
  let idIdx = 0
  let updateIdx = 0

  // ============================================================================
  // CRUD Suite
  // ============================================================================

  const crudSuite = new Benchmark.Suite('CRUD Operations')

  crudSuite
    .add('create() - single insert', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        createIdx++
        await users.create({ name: `bench${createIdx}`, email: `bench${createIdx}@test.com`, role: 'user', tags: [] })
        deferred.resolve()
      },
    })
    .add('find() - select by ID', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.find(ids[idIdx++ % ids.length])
        deferred.resolve()
      },
    })
    .add('update() - single update', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.update(ids[updateIdx++ % ids.length], { age: updateIdx })
        deferred.resolve()
      },
    })
    .add('findBy() - simple where', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.findBy({ where: { role: 'admin' } })
        deferred.resolve()
      },
    })
    .add('findBy() - where + order + limit', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.findBy({ where: { role: 'user' }, order: { name: 'ASC' }, limit: 10 })
        deferred.resolve()
      },
    })
    .add('count()', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.count({ where: { role: 'admin' } })
        deferred.resolve()
      },
    })
    .add('paginate() - page of 20', {
      defer: true,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.paginate({ page: 1, pageSize: 20 })
        deferred.resolve()
      },
    })
    .on('cycle', (event: Benchmark.Event) => {
      console.log(String(event.target))
    })
    .on('complete', async () => {
      // Cleanup
      await db`DROP TABLE IF EXISTS bench_users`
      await orm.disconnect()
      console.log('\nBenchmark complete!')
    })

  console.log('\nRunning CRUD benchmarks...\n')
  crudSuite.run({ async: true })
}

try {
  main()
}
catch (e) {
  console.error(e)
}

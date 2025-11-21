import Benchmark from 'benchmark'
import { orm, timestamps } from './src'

// ============================================================================
// Test Entity
// ============================================================================

const minSamples = 20
const maxTime = 2

const BenchUser = orm
  .entity('bench_users', {
    name: orm.string(),
    email: orm.string().unique(),
    age: orm.number().nullable(),
    role: orm.enum(['admin', 'user', 'moderator'] as const),
    isActive: orm.boolean().default(true),
    metadata: orm.jsonb<{ score: number, tags: string[] }>().nullable(),
    tags: orm.array('string'),
    scores: orm.array('number'),
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
      scores INTEGER[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `

  const users = orm.repo(BenchUser)

  // Warmup
  console.log('Warming up...')
  for (let i = 0; i < 10; i++) {
    const u = await users.create({ name: `warmup${i}`, email: `warmup${i}@test.com`, role: 'user', tags: [], scores: [] })

    await users.find(u.id)
    await users.delete(u.id)
  }

  // Prepare test data
  await db`TRUNCATE bench_users RESTART IDENTITY`
  const testUsers = await users.createMany(
    Array.from({ length: 100 }, (_, i) => ({
      name: `user${i}`,
      email: `user${i}@test.com`,
      age: 20 + (i % 50),
      role: (i % 3 === 0 ? 'admin' : i % 3 === 1 ? 'moderator' : 'user') as 'admin' | 'user' | 'moderator',
      tags: ['test', `tag${i % 10}`],
      scores: [i, i * 2, i * 3],
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
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        createIdx++
        await users.create({ name: `bench${createIdx}`, email: `bench${createIdx}@test.com`, role: 'user', tags: [], scores: [] })
        deferred.resolve()
      },
    })
    .add('find() - select by ID', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.find(ids[idIdx++ % ids.length])
        deferred.resolve()
      },
    })
    .add('update() - single update', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.update(ids[updateIdx++ % ids.length], { age: updateIdx })
        deferred.resolve()
      },
    })
    .add('findBy() - simple where', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.findBy({ where: { role: 'admin' } })
        deferred.resolve()
      },
    })
    .add('findBy() - where + order + limit', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.findBy({ where: { role: 'user' }, order: { name: 'ASC' }, limit: 10 })
        deferred.resolve()
      },
    })
    .add('count()', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.count({ where: { role: 'admin' } })
        deferred.resolve()
      },
    })
    .add('paginate() - page of 20', {
      defer: true,
      minSamples,
      maxTime,
      fn: async (deferred: Benchmark.Deferred) => {
        await users.paginate({ page: 1, pageSize: 20 })
        deferred.resolve()
      },
    })
    .on('cycle', (event: Benchmark.Event) => {
      console.log(String(event.target))
    })
    .on('complete', () => {
      console.log('\n')
      runRawVsOrmSuite()
    })

  // ============================================================================
  // Raw SQL vs ORM Suite
  // ============================================================================

  function runRawVsOrmSuite() {
    console.log('Raw SQL vs ORM Query Builder')
    console.log('=============================\n')

    const rawVsOrmSuite = new Benchmark.Suite('Raw SQL vs ORM')

    rawVsOrmSuite
      // Simple SELECT by ID
      .add('Raw SQL: SELECT by ID', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          const id = ids[idIdx++ % ids.length]

          await db`SELECT * FROM bench_users WHERE id = ${id} LIMIT 1`
          deferred.resolve()
        },
      })
      .add('ORM: find() by ID', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.find(ids[idIdx++ % ids.length])
          deferred.resolve()
        },
      })

      // Simple WHERE
      .add('Raw SQL: WHERE role = value', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await db`SELECT * FROM bench_users WHERE role = ${'admin'}`
          deferred.resolve()
        },
      })
      .add('ORM: findBy() WHERE role', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.findBy({ where: { role: 'admin' } })
          deferred.resolve()
        },
      })

      // Complex WHERE (3 conditions)
      .add('Raw SQL: 3 WHERE conditions', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await db`SELECT * FROM bench_users WHERE role = ${'user'} AND age >= ${25} AND is_active = ${true}`
          deferred.resolve()
        },
      })
      .add('ORM: findBy() 3 WHERE conditions', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.findBy({
            where: {
              role: 'user',
              age: { gte: 25 },
              isActive: true,
            },
          })
          deferred.resolve()
        },
      })

      // Complex WHERE (5 conditions)
      .add('Raw SQL: 5 WHERE conditions', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await db`SELECT * FROM bench_users WHERE role = ${'user'} AND age >= ${25} AND age <= ${50} AND is_active = ${true} AND name LIKE ${'user%'}`
          deferred.resolve()
        },
      })
      .add('ORM: findBy() 5 WHERE conditions', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.findBy({
            where: {
              role: 'user',
              age: { gte: 25, lte: 50 },
              isActive: true,
              name: { like: 'user%' },
            },
          })
          deferred.resolve()
        },
      })

      // INSERT
      .add('Raw SQL: INSERT', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          createIdx++
          await db`INSERT INTO bench_users (name, email, role, tags, scores) VALUES (${`raw${createIdx}`}, ${`raw${createIdx}@test.com`}, ${'user'}, '{}', '{}') RETURNING id`
          deferred.resolve()
        },
      })
      .add('ORM: create()', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          createIdx++
          await users.create({ name: `orm${createIdx}`, email: `orm${createIdx}@test.com`, role: 'user', tags: [], scores: [] })
          deferred.resolve()
        },
      })
      .add('ORM: create() skipValidation', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          createIdx++
          await users.create({ name: `orm${createIdx}`, email: `orm${createIdx}@test.com`, role: 'user', tags: [], scores: [] }, { skipValidation: true })
          deferred.resolve()
        },
      })

      .on('cycle', (event: Benchmark.Event) => {
        console.log(String(event.target))
      })
      .on('complete', () => {
        console.log('\n')
        runBulkSuite()
      })

    rawVsOrmSuite.run({ async: true })
  }

  // ============================================================================
  // Bulk Operations Suite
  // ============================================================================

  function runBulkSuite() {
    console.log('Bulk Operations')
    console.log('================\n')

    const bulkSuite = new Benchmark.Suite('Bulk Operations')
    let bulkIdx = 10000

    bulkSuite
      .add('createMany(10) with validation', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          bulkIdx += 10
          await users.createMany(
            Array.from({ length: 10 }, (_, i) => ({
              name: `bulk${bulkIdx + i}`,
              email: `bulk${bulkIdx + i}@test.com`,
              role: 'user' as const,
              tags: [],
              scores: [],
            })),
          )
          deferred.resolve()
        },
      })
      .add('createMany(10) skipValidation', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          bulkIdx += 10
          await users.createMany(
            Array.from({ length: 10 }, (_, i) => ({
              name: `bulk${bulkIdx + i}`,
              email: `bulk${bulkIdx + i}@test.com`,
              role: 'user' as const,
              tags: [],
              scores: [],
            })),
            { skipValidation: true },
          )
          deferred.resolve()
        },
      })
      .add('createMany(100) with validation', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          bulkIdx += 100
          await users.createMany(
            Array.from({ length: 100 }, (_, i) => ({
              name: `bulk${bulkIdx + i}`,
              email: `bulk${bulkIdx + i}@test.com`,
              role: 'user' as const,
              tags: [],
              scores: [],
            })),
          )
          deferred.resolve()
        },
      })
      .add('createMany(100) skipValidation', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          bulkIdx += 100
          await users.createMany(
            Array.from({ length: 100 }, (_, i) => ({
              name: `bulk${bulkIdx + i}`,
              email: `bulk${bulkIdx + i}@test.com`,
              role: 'user' as const,
              tags: [],
              scores: [],
            })),
            { skipValidation: true },
          )
          deferred.resolve()
        },
      })
      .on('cycle', (event: Benchmark.Event) => {
        console.log(String(event.target))
      })
      .on('complete', async () => {
        console.log('\n')
        await runArrayParsingSuite()
      })

    bulkSuite.run({ async: true })
  }

  // ============================================================================
  // Array Parsing Suite
  // ============================================================================

  async function runArrayParsingSuite() {
    console.log('Array Parsing Performance')
    console.log('=========================\n')

    // Insert test data with arrays
    await db`TRUNCATE bench_users RESTART IDENTITY`
    await users.createMany(
      Array.from({ length: 100 }, (_, i) => ({
        name: `arrayuser${i}`,
        email: `arrayuser${i}@test.com`,
        role: 'user' as const,
        tags: Array.from({ length: 20 }, (_, j) => `tag${j}`),
        scores: Array.from({ length: 50 }, (_, j) => j * i),
      })),
      { skipValidation: true },
    )

    const arraySuite = new Benchmark.Suite('Array Parsing')

    arraySuite
      .add('findAll() with string arrays (20 elements each)', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.findBy({ limit: 50 })
          deferred.resolve()
        },
      })
      .add('findAll() with number arrays (50 elements each)', {
        defer: true,
        minSamples,
        maxTime,
        fn: async (deferred: Benchmark.Deferred) => {
          await users.findBy({ limit: 50 })
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

    arraySuite.run({ async: true })
  }

  console.log('\nRunning CRUD benchmarks...\n')
  crudSuite.run({ async: true })
}

try {
  main()
}
catch (e) {
  console.error(e)
}

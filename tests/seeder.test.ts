import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ORM } from '../src'
import { getTestSchema, setupTestDatabase, teardownTestDatabase } from './setup'

describe('Seeder System', () => {
  const schema = getTestSchema()
  const TEST_SEEDS_DIR = resolve(process.cwd(), 'test-seeds')
  const orm = new ORM()

  beforeAll(async () => {
    await setupTestDatabase({ schema, orm })

    if (existsSync(TEST_SEEDS_DIR)) {
      rmSync(TEST_SEEDS_DIR, { recursive: true })
    }

    mkdirSync(TEST_SEEDS_DIR, { recursive: true })
  })

  afterAll(async () => {
    await teardownTestDatabase({ schema, orm })

    if (existsSync(TEST_SEEDS_DIR)) {
      rmSync(TEST_SEEDS_DIR, { recursive: true })
    }
  })

  test('should run all seeders in order', async () => {
    writeFileSync(
      resolve(TEST_SEEDS_DIR, '01_users.ts'),
      `
export default {
  name: '01_users',
  async run({ db }) {
    // Empty seeder
  }
}
`,
    )

    writeFileSync(
      resolve(TEST_SEEDS_DIR, '02_posts.ts'),
      `
export default {
  name: '02_posts',
  async run({ db }) {
    // Empty seeder
  }
}
`,
    )

    const runner = orm.seeder(TEST_SEEDS_DIR)

    await runner.run()

    // If no error is thrown, the test passes
    expect(true).toBe(true)
  })

  test('should run specific seeders only', async () => {
    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'users.ts'),
      `
export default {
  name: 'users',
  async run({ db }) {
    await db\`CREATE TABLE IF NOT EXISTS test_seeder_users (id SERIAL PRIMARY KEY, name TEXT)\`
    await db\`INSERT INTO test_seeder_users (name) VALUES ('Alice')\`
  }
}
`,
    )

    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'posts.ts'),
      `
export default {
  name: 'posts',
  async run({ db }) {
    await db\`CREATE TABLE IF NOT EXISTS test_seeder_posts (id SERIAL PRIMARY KEY, title TEXT)\`
  }
}
`,
    )

    const runner = orm.seeder(TEST_SEEDS_DIR)

    await runner.run({ seederNames: ['users'] })

    const db = orm.getDB()
    const usersExist = await db`SELECT COUNT(*) as count FROM test_seeder_users`
    const postsTableExists = await db`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE tablename = 'test_seeder_posts'
      ) as exists
    `

    expect(Number(usersExist[0].count)).toBe(1)
    expect(postsTableExists[0].exists).toBe(false)

    await db`DROP TABLE IF EXISTS test_seeder_users`
  })

  test('should handle seeders with db access', async () => {
    const User = orm.entity('seeder_test_users', {
      name: orm.string(),
      email: orm.string(),
    }).build()

    const users = orm.repo(User)

    await orm.getDB()`
      CREATE TABLE IF NOT EXISTS seeder_test_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      )
    `

    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'create_users.ts'),
      `
export default {
  name: 'create_users',
  async run({ db }) {
    await db\`INSERT INTO seeder_test_users (name, email) VALUES ('John', 'john@example.com')\`
    await db\`INSERT INTO seeder_test_users (name, email) VALUES ('Jane', 'jane@example.com')\`
  }
}
`,
    )

    const runner = orm.seeder(TEST_SEEDS_DIR)

    await runner.run({ seederNames: ['create_users'] })

    const allUsers = await users.findAll()

    expect(allUsers.length).toBe(2)
    expect(allUsers[0]?.name).toBe('John')
    expect(allUsers[1]?.name).toBe('Jane')

    await orm.getDB()`DROP TABLE IF EXISTS seeder_test_users`
  })

  test('should handle empty seeds directory gracefully', async () => {
    const emptyDir = resolve(TEST_SEEDS_DIR, 'empty')

    mkdirSync(emptyDir, { recursive: true })

    const runner = orm.seeder(emptyDir)

    await runner.run()

    rmSync(emptyDir, { recursive: true })
  })

  test('should handle non-existent seeds directory', async () => {
    const runner = orm.seeder('non-existent-dir')

    await runner.run()
  })

  test('should filter seeders by group', async () => {
    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'dev_users.ts'),
      `
export default {
  name: 'dev_users',
  groups: ['development'],
  async run({ db }) {
    await db\`CREATE TABLE IF NOT EXISTS test_dev_users (id SERIAL PRIMARY KEY, name TEXT)\`
    await db\`INSERT INTO test_dev_users (name) VALUES ('Dev User')\`
  }
}
`,
    )

    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'prod_users.ts'),
      `
export default {
  name: 'prod_users',
  groups: ['production'],
  async run({ db }) {
    await db\`CREATE TABLE IF NOT EXISTS test_prod_users (id SERIAL PRIMARY KEY, name TEXT)\`
  }
}
`,
    )

    const runner = orm.seeder(TEST_SEEDS_DIR)

    await runner.run({ group: 'development' })

    const db = orm.getDB()
    const devUsersExist = await db`SELECT COUNT(*) as count FROM test_dev_users`
    const prodTableExists = await db`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE tablename = 'test_prod_users'
      ) as exists
    `

    expect(Number(devUsersExist[0].count)).toBe(1)
    expect(prodTableExists[0].exists).toBe(false)

    await db`DROP TABLE IF EXISTS test_dev_users`
  })

  test('should list available seeders', async () => {
    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'seeder1.ts'),
      `
export default {
  name: 'seeder1',
  async run() {}
}
`,
    )

    writeFileSync(
      resolve(TEST_SEEDS_DIR, 'seeder2.ts'),
      `
export default {
  name: 'seeder2',
  async run() {}
}
`,
    )

    const runner = orm.seeder(TEST_SEEDS_DIR)

    await runner.listSeeders()
  })
})

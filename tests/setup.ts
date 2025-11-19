import type { EntityDefinition } from '../src/types'
import { ObjectEntries, toSnake } from '@kaynooo/utils'
import { afterAll, beforeAll, expect } from 'bun:test'
import { orm } from '../src'

// ============================================================================
// Test Database Configuration
// ============================================================================

export const TEST_DB_CONFIG = process.env.DATABASE_URL
  || 'postgres://test:test@localhost:5432/orm_test'

// ============================================================================
// Test Database Lifecycle
// ============================================================================

export async function setupTestDatabase() {
  await orm.connect({
    connectionString: TEST_DB_CONFIG,
    migrations: {
      autoMigrate: true,
      noInteraction: true, // Auto-apply schema changes without prompting
      killIfUpdate: false, // Don't exit on schema changes
      safeMigrations: false, // Allow dropping columns in tests
    },
  })
  console.log('✅ Test database connected')
}

export async function teardownTestDatabase() {
  await orm.disconnect()
  console.log('✅ Test database disconnected')
}

// ============================================================================
// Table Management
// ============================================================================

export async function cleanupTable(tableName: string): Promise<void> {
  const db = orm.getDB()

  try {
    await db`DROP TABLE IF EXISTS ${db(tableName)} CASCADE`
  }
  catch (error) {
    console.warn(`Failed to drop table ${tableName}:`, error)
  }
}

export async function cleanupTables(...tableNames: string[]): Promise<void> {
  for (const tableName of tableNames) {
    await cleanupTable(tableName)
  }
}

export async function truncateTable(tableName: string): Promise<void> {
  const db = orm.getDB()

  try {
    await db`TRUNCATE TABLE ${db(tableName)} RESTART IDENTITY CASCADE`
  }
  catch (error) {
    // Table might not exist, ignore
  }
}

export async function truncateTables(...tableNames: string[]): Promise<void> {
  for (const tableName of tableNames) {
    await truncateTable(tableName)
  }
}

// ============================================================================
// Test Entity Creation Helper (for dynamic per-test entities)
// ============================================================================

/**
 * Helper to create tables for entities that are defined dynamically within tests.
 * For entities defined at module level, use auto-migration by registering
 * repositories before calling setupTestDatabase().
 *
 * This function is kept for backward compatibility with tests that create
 * entities dynamically (hooks, validation, traits tests).
 *
 * Note: Auto-migration is preferred for module-level entities.
 */
export async function createTestTable(
  entityDef: EntityDefinition<any>,
): Promise<void> {
  const db = orm.getDB()
  const { tableName, schema } = entityDef

  // Build column definitions
  const columns: string[] = ['id SERIAL PRIMARY KEY']

  for (const [fieldName, config] of ObjectEntries(schema)) {
    const columnName = config.columnName || toSnake(fieldName)
    let columnDef = `${columnName} `

    // Map field type to SQL type
    switch (config.type) {
    case 'string':
      columnDef += config.maxLength ? `VARCHAR(${config.maxLength})` : 'TEXT'

      break
    case 'number':
      columnDef += config.integer ? 'INTEGER' : 'DOUBLE PRECISION'

      break
    case 'boolean':
      columnDef += 'BOOLEAN'

      break
    case 'json':
      columnDef += 'JSON'

      break
    case 'jsonb':
      columnDef += 'JSONB'

      break
    case 'uuid':
      columnDef += 'UUID'

      break
    case 'timestamp':
      columnDef += 'TIMESTAMP'

      break
    case 'date':
      columnDef += 'DATE'

      break
    case 'array':
      if (config.arrayType === 'string')
        columnDef += 'TEXT[]'
      else if (config.arrayType === 'number')
        columnDef += 'INTEGER[]'
      else if (config.arrayType === 'boolean')
        columnDef += 'BOOLEAN[]'

      break
    case 'enum':
      columnDef += 'TEXT'

      break
    case 'blob':
      columnDef += 'BYTEA'

      break
    }

    // Add constraints
    if (!config.nullable) {
      columnDef += ' NOT NULL'
    }

    if (config.unique) {
      columnDef += ' UNIQUE'
    }

    if (config.default !== undefined) {
      if (typeof config.default === 'string') {
        columnDef += ` DEFAULT '${config.default}'`
      }
      else if (typeof config.default === 'boolean') {
        columnDef += ` DEFAULT ${config.default}`
      }
      else if (typeof config.default === 'number') {
        columnDef += ` DEFAULT ${config.default}`
      }
      else if (Array.isArray(config.default)) {
        columnDef += ` DEFAULT '{}'`
      }
    }

    columns.push(columnDef)
  }

  // Add unique constraints
  if (entityDef.unique) {
    for (const uniqueCols of entityDef.unique) {
      columns.push(`UNIQUE (${uniqueCols.join(', ')})`)
    }
  }

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      ${columns.join(',\n      ')}
    )
  `

  await db.unsafe(createTableSQL)
}

// ============================================================================
// Global Test Hooks
// ============================================================================

export function setupGlobalTestHooks() {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })
}

// ============================================================================
// Test Data Factories
// ============================================================================

export const testData = {
  user: {
    valid: () => ({
      name: 'Test User',
      email: 'test@example.com',
      role: 'user' as const,
      tags: ['test'],
    }),
    admin: () => ({
      name: 'Admin User',
      email: 'admin@example.com',
      role: 'admin' as const,
      tags: ['admin', 'test'],
    }),
    withAge: (age: number) => ({
      ...testData.user.valid(),
      age,
    }),
    withMetadata: (metadata: any) => ({
      ...testData.user.valid(),
      metadata,
    }),
  },
  post: {
    valid: (authorId: number) => ({
      title: 'Test Post',
      content: 'Test content',
      authorId,
    }),
    published: (authorId: number) => ({
      ...testData.post.valid(authorId),
      published: true,
      publishedAt: new Date(),
    }),
  },
}

// ============================================================================
// Assertion Helpers
// ============================================================================

export function expectEntityToMatch(
  entity: any,
  expected: Partial<any>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value instanceof Date) {
      // Compare dates by time
      expect(entity[key]?.getTime()).toBe(value.getTime())
    }
    else if (Array.isArray(value)) {
      expect(entity[key]).toEqual(value)
    }
    else {
      expect(entity[key]).toBe(value)
    }
  }
}

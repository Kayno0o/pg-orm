import type { MigrationConfig } from './migration/types'
import { sql as bunSql, SQL } from 'bun'

// ============================================================================
// Database Configuration
// ============================================================================

export interface DatabaseConfig {
  // Connection string (alternative to individual connection parameters)
  connectionString?: string

  // Connection parameters
  hostname?: string
  port?: number
  database?: string
  username?: string
  password?: string

  // Connection pool settings
  poolMin?: number
  poolMax?: number
  idleTimeout?: number
  connectionTimeout?: number

  // Additional PostgreSQL options
  ssl?: boolean | object
  max?: number
  min?: number

  // Migration configuration
  migrations?: MigrationConfig
}

// ============================================================================
// Database Instance Management
// ============================================================================

let dbInstance: SQL | null = null

export async function initializeDatabase(connectionString: string | DatabaseConfig): Promise<SQL> {
  if (typeof connectionString === 'string') {
    dbInstance = new SQL(connectionString)
  }
  else {
    // Extract migration config, pass rest to SQL
    const {
      poolMin: _poolMin,
      poolMax: _poolMax,
      idleTimeout: _idleTimeout,
      connectionTimeout: _connectionTimeout,
      migrations: _migrations,
      ...rest
    } = connectionString

    // If connectionString is provided in config, use it
    if (rest.connectionString) {
      dbInstance = new SQL(rest.connectionString)
    }
    else {
      // Otherwise construct from individual parameters
      // Note: Bun SQL pool settings via max/min are passed through rest
      dbInstance = new SQL(rest as any)
    }
  }

  // Test connection
  try {
    await dbInstance`SELECT 1 as test`
  }
  catch (error) {
    if (error instanceof SQL.PostgresError) {
      throw new Error(
        `Failed to connect to PostgreSQL: ${error.message}\n`
        + `Code: ${error.code || 'unknown'}\n${
          String(error.detail ? `Detail: ${error.detail}\n` : '')
        }${String(error.hint ? `Hint: ${error.hint}` : '')}`,
      )
    }

    throw new Error(`Database connection failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return dbInstance
}

export function getDatabase(): SQL {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call orm.connect() first.')
  }

  return dbInstance
}

export async function closeDatabase(options?: { timeout?: number }): Promise<void> {
  if (dbInstance) {
    await dbInstance.close(options)
    dbInstance = null
  }
}

// ============================================================================
// Transaction Helpers
// ============================================================================

export async function transaction<T>(callback: (tx: SQL) => Promise<T>): Promise<T> {
  const db = getDatabase()

  try {
    return await db.begin(callback)
  }
  catch (error) {
    if (error instanceof SQL.PostgresError) {
      throw new Error(
        `Transaction failed: ${error.message}\n`
        + `Code: ${error.code || 'unknown'}\n${
          String(error.detail ? `Detail: ${error.detail}\n` : '')
        }${String(error.hint ? `Hint: ${error.hint}` : '')}`,
      )
    }

    throw error
  }
}

// Export SQL helpers
export { bunSql as sql, SQL }

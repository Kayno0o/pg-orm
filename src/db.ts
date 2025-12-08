import type { CacheAdapter } from './cache'
import type { QueryLoggingConfig } from './logger'
import type { MigrationConfig } from './migration/types'
import { sql as bunSql, SQL } from 'bun'
import { queryLogger } from './logger'

/**
 * Configuration options for the database connection.
 */
export interface DatabaseConfig {
  connectionString?: string
  hostname?: string
  port?: number
  database?: string
  username?: string
  password?: string
  poolMin?: number
  poolMax?: number
  idleTimeout?: number
  connectionTimeout?: number
  ssl?: boolean | object
  max?: number
  min?: number
  schema?: string
  migrations?: MigrationConfig
  cache?: CacheAdapter
  limits?: {
    bulkOperations?: number
    arraySize?: number
    stringLength?: number
    jsonSize?: number
    jsonDepth?: number
  }
  validation?: {
    strict?: boolean
  }
  logging?: QueryLoggingConfig
  errorHandling?: {
    exposeInternalErrors?: boolean
    includeStackTraces?: boolean
  }
}

let dbInstance: SQL | null = null
let dbConfig: DatabaseConfig | null = null

/**
 * Sets the global database instance.
 * Used internally for backward compatibility with singleton pattern.
 * @param db - The SQL instance to set as global.
 * @internal
 */
export function setGlobalDatabase(db: SQL): void {
  dbInstance = db
}

/**
 * Initializes the database connection.
 * @param connectionString - Connection string or configuration object.
 */
export async function initializeDatabase(connectionString: string | DatabaseConfig): Promise<SQL> {
  if (typeof connectionString === 'object') {
    dbConfig = connectionString

    if (connectionString.logging) {
      queryLogger.configure(connectionString.logging)
    }
  }
  else {
    dbConfig = { connectionString }
  }

  if (typeof connectionString === 'string') {
    dbInstance = new SQL(connectionString)
  }
  else {
    const {
      poolMin: _poolMin,
      poolMax: _poolMax,
      idleTimeout: _idleTimeout,
      connectionTimeout: _connectionTimeout,
      migrations: _migrations,
      logging: _logging,
      ...rest
    } = connectionString

    if (rest.connectionString) {
      dbInstance = new SQL(rest.connectionString)
    }
    else {
      dbInstance = new SQL(rest as any)
    }
  }

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

/**
 * Retrieves the active database connection.
 * @throws Error if the database is not initialized.
 * @deprecated Use orm.getDB() instead. This function will be removed in v2.0.0.
 */
export function getDatabase(): SQL {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call orm.connect() first.')
  }

  console.warn('DEPRECATED: getDatabase() will be removed in v2.0.0. Use orm.getDB() instead.')

  return dbInstance
}

/**
 * Retrieves the current database configuration.
 * @throws Error if the database is not initialized.
 */
export function getDatabaseConfig(): DatabaseConfig {
  if (!dbConfig) {
    throw new Error('Database not initialized. Call orm.connect() first.')
  }

  return dbConfig
}

/**
 * Closes the database connection.
 * @param options - Optional configuration object.
 * @param options.timeout - The maximum time in milliseconds to wait for connections to close.
 */
export async function closeDatabase(options?: { timeout?: number }): Promise<void> {
  if (dbInstance) {
    await dbInstance.close(options)
    dbInstance = null
    dbConfig = null
  }
}

/**
 * Represents the health status of the connection pool.
 */
export interface PoolHealth {
  isHealthy: boolean
  hasConnection: boolean
  lastError?: Error
}

/**
 * Checks the health of the database connection pool.
 */
export function getPoolHealth(): PoolHealth {
  const hasConnection = dbInstance !== null

  return {
    isHealthy: hasConnection,
    hasConnection,
    lastError: undefined,
  }
}

/**
 * Executes a callback within a database transaction.
 * @param callback - The function to execute within the transaction.
 */
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

export { bunSql as sql, SQL }

/**
 * Database connection management
 */

import type { AbstractEntity } from './entity'
import type { AbstractRepository } from './repository'
import { sql as defaultSql, SQL } from 'bun'

type EntityConstructor<T extends AbstractEntity = AbstractEntity> = new () => T

let dbInstance: SQL | null = null

const repositoryRegistry = new Map<EntityConstructor, AbstractRepository<AbstractEntity>>()

export async function initDB(
  connectionStringOrConfig: string | SQL.Options,
  repositories: AbstractRepository<AbstractEntity>[],
): Promise<void> {
  if (typeof connectionStringOrConfig === 'string') {
    dbInstance = new SQL(connectionStringOrConfig)
  }
  else {
    dbInstance = new SQL(connectionStringOrConfig)
  }

  for (const repository of repositories) {
    const entityClass = repository.getEntityClass()

    repositoryRegistry.set(entityClass, repository)
    repository.setDB(dbInstance)
  }

  try {
    await dbInstance`SELECT 1 as test`
  }
  catch (error) {
    if (error instanceof SQL.PostgresError) {
      throw new TypeError(
        `Failed to connect to PostgreSQL database: ${error.message}\n`
        + `Code: ${error.code || 'unknown'}\n${error.detail ? `Detail: ${error.detail}\n` : ''}${error.hint ? `Hint: ${error.hint}` : ''}`,
      )
    }

    throw new Error(`Failed to connect to database: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function getRepository<T extends AbstractEntity>(
  entityClass: EntityConstructor<T>,
): AbstractRepository<T> {
  const repository = repositoryRegistry.get(entityClass as EntityConstructor)

  if (!repository) {
    throw new Error(
      `Repository for ${entityClass.name} not found. Did you register it in initDB()?`,
    )
  }

  return repository as AbstractRepository<T>
}

/**
 * @example
 * ```typescript
 * const db = getDB()
 * const result = await db`SELECT * FROM custom_table`
 * ```
 */
export function getDB(): SQL {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDB() first.')
  }

  return dbInstance
}

export async function closeDB(options?: { timeout?: number }): Promise<void> {
  if (dbInstance) {
    await dbInstance.close(options)
    dbInstance = null
    repositoryRegistry.clear()
  }
}

/**
 * Automatically commits on success, rolls back on error
 * @example
 * ```typescript
 * await transaction(async (tx) => {
 *   await tx`INSERT INTO users (name) VALUES ('Alice')`
 *   await tx`UPDATE accounts SET balance = balance - 100 WHERE user_id = 1`
 * })
 * ```
 */
export async function transaction<T>(
  callback: (tx: SQL) => Promise<T>,
): Promise<T> {
  const db = getDB()

  try {
    return await db.begin(callback)
  }
  catch (error) {
    if (error instanceof SQL.PostgresError) {
      throw new TypeError(
        `Transaction failed: ${error.message}\n`
        + `Code: ${error.code || 'unknown'}\n${error.detail ? `Detail: ${error.detail}\n` : ''}${error.hint ? `Hint: ${error.hint}` : ''}`,
      )
    }

    throw error
  }
}

export const sql = new Proxy(defaultSql, {
  get(target, prop) {
    if (!dbInstance) {
      throw new Error('Database not initialized. Call initDB() first.')
    }

    return Reflect.get(dbInstance, prop)
  },
  apply(target, thisArg, args) {
    if (!dbInstance) {
      throw new Error('Database not initialized. Call initDB() first.')
    }

    return Reflect.apply(dbInstance, thisArg, args as unknown[])
  },
})

import type { AbstractEntity } from './entity'
import type { AbstractRepository } from './repository'
import type { QueryOptions } from './types'

// Type helper for constructor
type Constructor<T = object> = new (...args: any[]) => T

/**
 * Soft Delete Mixin
 * Adds soft delete functionality to entities
 * Marks entities as deleted instead of actually removing them
 */
export function withSoftDelete<T extends AbstractEntity, TBase extends Constructor<AbstractRepository<T>>>(
  Base: TBase,
) {
  return class SoftDeletableRepository extends Base {
    /**
     * Soft delete: marks entity as deleted instead of removing
     */
    override async delete(id: number): Promise<void> {
      // Override delete to set deleted_at timestamp
      await this.update(id, { deleted_at: new Date() } as any)
    }

    /**
     * Permanently delete entity from database
     */
    async forceDelete(id: number): Promise<void> {
      const db = this.getDBContext()

      await db`DELETE FROM ${db((this as any).tableName)} WHERE id = ${id}`
    }

    /**
     * Restore soft-deleted entity
     */
    async restore(id: number): Promise<T> {
      return await this.update(id, { deleted_at: null } as any)
    }

    /**
     * Find all non-deleted entities
     */
    override async findAll(): Promise<T[]> {
      const db = this.getDBContext()
      const results = await db`
        SELECT * FROM ${db((this as any).tableName)}
        WHERE deleted_at IS NULL
      `

      return results.map((row: any) => (this as any).mapRowToEntity(row))
    }

    /**
     * Find entity by ID (only non-deleted)
     */
    override async find(id: number): Promise<T | null> {
      const db = this.getDBContext()
      const [result] = await db`
        SELECT * FROM ${db((this as any).tableName)}
        WHERE id = ${id} AND deleted_at IS NULL
        LIMIT 1
      `

      return result ? (this as any).mapRowToEntity(result) : null
    }

    /**
     * Find all entities including soft-deleted ones
     */
    async findAllWithTrashed(): Promise<T[]> {
      return super.findAll()
    }

    /**
     * Find entity by ID including soft-deleted ones
     */
    async findWithTrashed(id: number): Promise<T | null> {
      return super.find(id)
    }

    /**
     * Find only soft-deleted entities
     */
    async findOnlyTrashed(): Promise<T[]> {
      const db = this.getDBContext()
      const results = await db`
        SELECT * FROM ${db((this as any).tableName)}
        WHERE deleted_at IS NOT NULL
      `

      return results.map((row: any) => (this as any).mapRowToEntity(row))
    }

    /**
     * Count non-deleted entities
     */
    override async count(options?: QueryOptions<T>): Promise<number> {
      const db = this.getDBContext()

      if (!options || Object.keys(options).length === 0) {
        const [result] = await db`
          SELECT COUNT(*)::int as count FROM ${db((this as any).tableName)}
          WHERE deleted_at IS NULL
        `

        return result?.count || 0
      }

      // Build query with deleted_at IS NULL filter
      const results = await this.buildAndExecuteSelectQuery(db, {
        ...options,
        limit: undefined,
        offset: undefined,
      })

      // Filter out soft-deleted results
      const filtered = results.filter((row: any) => row.deleted_at === null || row.deleted_at === undefined)

      return filtered.length
    }

    /**
     * Count including soft-deleted entities
     */
    async countWithTrashed(options?: QueryOptions<T>): Promise<number> {
      return super.count(options)
    }
  }
}

/**
 * Timestamps Mixin
 * Automatically manages created_at and updated_at timestamps
 */
export function withTimestamps<T extends AbstractEntity, TBase extends Constructor<AbstractRepository<T>>>(
  Base: TBase,
) {
  return class TimestampableRepository extends Base {
    override async create(data: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>): Promise<T> {
      const dataWithTimestamp = {
        ...data,
        created_at: new Date(),
        updated_at: new Date(),
      } as any

      return super.create(dataWithTimestamp)
    }

    override async update(
      id: number,
      data: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>,
    ): Promise<T> {
      const dataWithTimestamp = {
        ...data,
        updated_at: new Date(),
      } as any

      return super.update(id, dataWithTimestamp)
    }

    override async createMany(dataArray: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>[]): Promise<T[]> {
      const now = new Date()
      const dataWithTimestamps = dataArray.map(data => ({
        ...data,
        created_at: now,
        updated_at: now,
      })) as any

      return super.createMany(dataWithTimestamps)
    }
  }
}

/**
 * Paranoid Mixin
 * Combines soft delete with automatic timestamps
 * Named after Sequelize's paranoid mode
 */
export function withParanoid<T extends AbstractEntity, TBase extends Constructor<AbstractRepository<T>>>(
  Base: TBase,
) {
  return withSoftDelete(withTimestamps(Base))
}

/**
 * Query Scopes Mixin
 * Adds common query scopes for filtering
 */
export function withScopes<T extends AbstractEntity, TBase extends Constructor<AbstractRepository<T>>>(
  Base: TBase,
) {
  return class ScopedRepository extends Base {
    async latest(field = 'created_at', limit = 10): Promise<T[]> {
      return this.findAllBy({
        order: { [field]: 'desc' } as any,
        limit,
      })
    }

    async oldest(field = 'created_at', limit = 10): Promise<T[]> {
      return this.findAllBy({
        order: { [field]: 'asc' } as any,
        limit,
      })
    }

    async random(limit = 10): Promise<T[]> {
      const db = this.getDBContext()
      const results = await db`
        SELECT * FROM ${db((this as any).tableName)}
        ORDER BY RANDOM()
        LIMIT ${limit}
      `

      return results.map((row: any) => (this as any).mapRowToEntity(row))
    }

    async first(): Promise<T | null> {
      const results = await this.findAllBy({ limit: 1 })

      return results[0] || null
    }

    async last(): Promise<T | null> {
      const results = await this.findAllBy({
        order: { id: 'desc' } as any,
        limit: 1,
      })

      return results[0] || null
    }
  }
}

/**
 * Custom Mixin Builder
 * Allows creating custom mixins with typed methods
 */
export function createMixin<T extends AbstractEntity>() {
  return <TBase extends Constructor<AbstractRepository<T>>>(
    enhancer: (Base: TBase) => TBase,
  ) => enhancer
}

/**
 * Compose multiple mixins together
 * Example: compose(withSoftDelete, withTimestamps, withScopes)(AbstractRepository)
 */
export function compose<T extends AbstractEntity>(
  ...mixins: ((base: any) => any)[]
) {
  return (Base: Constructor<AbstractRepository<T>>) => {
    return mixins.reduce((acc, mixin) => mixin(acc), Base)
  }
}

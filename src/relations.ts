import type { Repository } from './repository'
import type { EntitySchema, InferEntity } from './types'

// ============================================================================
// Relation Helpers for Loading Related Entities
// ============================================================================

/**
 * Relation definition for a belongs-to relationship (many-to-one)
 *
 * Example:
 * ```typescript
 * const Post = orm.entity('posts', {
 *   authorId: orm.number().foreignKey('users'),
 *   title: orm.string()
 * }).build()
 *
 * const posts = orm.repo(Post)
 * const users = orm.repo(User)
 *
 * const postAuthor = belongsTo('authorId', users)
 *
 * const post = await posts.find(1)
 * const author = await postAuthor.load(post)
 * ```
 */
export function belongsTo<
  T extends EntitySchema,
  R extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  RTraits extends readonly any[] = readonly any[],
>(
  foreignKey: keyof InferEntity<T, TTraits>,
  relatedRepo: Repository<R, RTraits>,
) {
  return {
    /**
     * Load the related entity
     * @param entity - The entity containing the foreign key
     * @returns The related entity or null if not found
     */
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits> | null> {
      const fkValue = entity[foreignKey]

      if (fkValue === null || fkValue === undefined) {
        return null
      }

      // Assuming foreign keys are always numbers (id fields)
      return relatedRepo.find(fkValue as number)
    },

    /**
     * Load related entities for multiple parent entities (batch loading)
     * @param entities - Array of entities containing foreign keys
     * @returns Map of foreign key value to related entity
     */
    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>>> {
      // Extract unique foreign key values
      const fkValues = new Set<number>()

      for (const entity of entities) {
        const fkValue = entity[foreignKey]

        if (fkValue !== null && fkValue !== undefined) {
          fkValues.add(fkValue as number)
        }
      }

      if (fkValues.size === 0) {
        return new Map()
      }

      // Batch load all related entities
      const related = await relatedRepo.query()
        .whereIn('id', Array.from(fkValues))
        .execute() as InferEntity<R, RTraits>[]

      // Build map for quick lookup
      const relatedMap = new Map<number, InferEntity<R, RTraits>>()

      for (const item of related) {
        relatedMap.set(item.id as number, item)
      }

      return relatedMap
    },
  }
}

/**
 * Relation definition for a has-many relationship (one-to-many)
 *
 * Example:
 * ```typescript
 * const User = orm.entity('users', {
 *   name: orm.string()
 * }).build()
 *
 * const Post = orm.entity('posts', {
 *   authorId: orm.number().foreignKey('users'),
 *   title: orm.string()
 * }).build()
 *
 * const posts = orm.repo(Post)
 * const users = orm.repo(User)
 *
 * const userPosts = hasMany('authorId', posts)
 *
 * const user = await users.find(1)
 * const userPostsList = await userPosts.load(user)
 * ```
 */
export function hasMany<
  T extends EntitySchema,
  R extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  RTraits extends readonly any[] = readonly any[],
>(
  foreignKey: keyof InferEntity<R, RTraits>,
  relatedRepo: Repository<R, RTraits>,
) {
  return {
    /**
     * Load all related entities
     * @param entity - The parent entity
     * @returns Array of related entities
     */
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits>[]> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id)
        .execute()
    },

    /**
     * Load related entities for multiple parent entities (batch loading)
     * @param entities - Array of parent entities
     * @returns Map of parent entity ID to array of related entities
     */
    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>[]>> {
      // Extract parent IDs
      const parentIds = entities.map(e => e.id)

      if (parentIds.length === 0) {
        return new Map()
      }

      // Batch load all related entities
      const allRelated = await relatedRepo.query()
        .whereIn(foreignKey as any, parentIds)
        .execute() as InferEntity<R, RTraits>[]

      // Group by foreign key
      const relatedMap = new Map<number, InferEntity<R, RTraits>[]>()

      // Initialize empty arrays for all parents
      for (const parentId of parentIds) {
        relatedMap.set(parentId as number, [])
      }

      // Group related entities
      for (const item of allRelated) {
        const fkValue = item[foreignKey] as number
        const existing = relatedMap.get(fkValue) || []

        existing.push(item)
        relatedMap.set(fkValue, existing)
      }

      return relatedMap
    },

    /**
     * Count related entities without loading them
     * @param entity - The parent entity
     * @returns Count of related entities
     */
    async count(entity: InferEntity<T, TTraits>): Promise<number> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id)
        .count()
    },
  }
}

/**
 * Relation definition for a has-one relationship (one-to-one)
 *
 * Example:
 * ```typescript
 * const User = orm.entity('users', {
 *   name: orm.string()
 * }).build()
 *
 * const Profile = orm.entity('profiles', {
 *   userId: orm.number().foreignKey('users').unique(),
 *   bio: orm.string()
 * }).build()
 *
 * const profiles = orm.repo(Profile)
 * const users = orm.repo(User)
 *
 * const userProfile = hasOne('userId', profiles)
 *
 * const user = await users.find(1)
 * const profile = await userProfile.load(user)
 * ```
 */
export function hasOne<
  T extends EntitySchema,
  R extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  RTraits extends readonly any[] = readonly any[],
>(
  foreignKey: keyof InferEntity<R, RTraits>,
  relatedRepo: Repository<R, RTraits>,
) {
  return {
    /**
     * Load the related entity (expecting only one)
     * @param entity - The parent entity
     * @returns The related entity or null if not found
     */
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits> | null> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id)
        .findOne()
    },

    /**
     * Load related entities for multiple parent entities (batch loading)
     * @param entities - Array of parent entities
     * @returns Map of parent entity ID to related entity
     */
    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>>> {
      const parentIds = entities.map(e => e.id)

      if (parentIds.length === 0) {
        return new Map()
      }

      // Batch load all related entities
      const allRelated = await relatedRepo.query()
        .whereIn(foreignKey as any, parentIds)
        .execute() as InferEntity<R, RTraits>[]

      // Build map
      const relatedMap = new Map<number, InferEntity<R, RTraits>>()

      for (const item of allRelated) {
        const fkValue = item[foreignKey] as number

        relatedMap.set(fkValue, item)
      }

      return relatedMap
    },
  }
}

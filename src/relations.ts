import type { Repository } from './repository'
import type { EntitySchema, InferEntity } from './types'

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
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits> | null> {
      const fkValue = entity[foreignKey]

      if (fkValue === null || fkValue === undefined) {
        return null
      }

      return relatedRepo.find(fkValue as number)
    },

    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>>> {
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

      const related = await relatedRepo.query()
        .whereIn('id', Array.from(fkValues))
        .execute() as InferEntity<R, RTraits>[]

      const relatedMap = new Map<number, InferEntity<R, RTraits>>()

      for (const item of related) {
        relatedMap.set(item.id as number, item)
      }

      return relatedMap
    },
  }
}

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
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits>[]> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id as any)
        .execute()
    },

    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>[]>> {
      const parentIds = entities.map(e => e.id)

      if (parentIds.length === 0) {
        return new Map()
      }

      const allRelated = await relatedRepo.query()
        .whereIn(foreignKey as any, parentIds as any)
        .execute() as InferEntity<R, RTraits>[]

      const relatedMap = new Map<number, InferEntity<R, RTraits>[]>()

      for (const parentId of parentIds) {
        relatedMap.set(parentId as number, [])
      }

      for (const item of allRelated) {
        const fkValue = item[foreignKey] as number
        const existing = relatedMap.get(fkValue) || []

        existing.push(item)
        relatedMap.set(fkValue, existing)
      }

      return relatedMap
    },

    async count(entity: InferEntity<T, TTraits>): Promise<number> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id as any)
        .count()
    },
  }
}

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
    async load(entity: InferEntity<T, TTraits>): Promise<InferEntity<R, RTraits> | null> {
      return relatedRepo.query()
        .where(foreignKey as any, '=', entity.id as any)
        .findOne()
    },

    async loadMany(
      entities: InferEntity<T, TTraits>[],
    ): Promise<Map<number, InferEntity<R, RTraits>>> {
      const parentIds = entities.map(e => e.id)

      if (parentIds.length === 0) {
        return new Map()
      }

      const allRelated = await relatedRepo.query()
        .whereIn(foreignKey as any, parentIds as any)
        .execute() as InferEntity<R, RTraits>[]

      const relatedMap = new Map<number, InferEntity<R, RTraits>>()

      for (const item of allRelated) {
        const fkValue = item[foreignKey] as number

        relatedMap.set(fkValue, item)
      }

      return relatedMap
    },
  }
}

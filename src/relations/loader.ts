import type { SQL } from 'bun'
import type { ORM } from '../orm'
import type { EntityDefinition, EntitySchema, InferEntity } from '../types'
import type {
  BelongsToConfig,
  HasManyConfig,
  HasOneConfig,
  ManyToManyConfig,
  RelationSchema,
} from './types'
import { toSnake } from '@kaynooo/utils'
import { Repository } from '../repository'

export class RelationLoader<T extends EntitySchema, R extends RelationSchema> {
  constructor(
    private db: SQL,
    private orm: ORM,
    private entity: EntityDefinition<T, any, any, R>,
  ) {}

  private validateEntityRegistration(tableName: string): void {
    const entity = this.orm.getEntityByTable(tableName)

    if (!entity) {
      throw new Error(
        `Entity "${tableName}" not registered in this ORM instance. `
        + `Relations must reference entities from the same ORM instance.`,
      )
    }
  }

  async loadRelations<With extends (keyof R)[]>(
    entities: InferEntity<T>[],
    relationNames: With,
  ): Promise<(InferEntity<T> & Partial<Record<With[number], any>>)[]> {
    if (entities.length === 0)
      return entities as any

    for (const relationName of relationNames) {
      const relationConfig = this.entity.relations[relationName]

      if (!relationConfig) {
        throw new Error(`Relation "${String(relationName)}" not found on ${this.entity.tableName}`)
      }

      // Validate that the related entity is registered in the same ORM instance
      this.validateEntityRegistration(relationConfig.tableName)

      const targetEntity = this.orm.getEntityByTable(relationConfig.tableName)

      if (!targetEntity) {
        throw new Error(`Entity for table "${relationConfig.tableName}" not found. Did you call .build() on it?`)
      }

      switch (relationConfig.type) {
      case 'hasOne':
        await this.loadHasOne(entities, relationName, relationConfig, targetEntity)

        break
      case 'hasMany':
        await this.loadHasMany(entities, relationName, relationConfig, targetEntity)

        break
      case 'belongsTo':
        await this.loadBelongsTo(entities, relationName, relationConfig, targetEntity)

        break
      case 'manyToMany':
        await this.loadManyToMany(entities, relationName, relationConfig, targetEntity)

        break
      }
    }

    return entities as any
  }

  private async loadHasMany(
    entities: InferEntity<T>[],
    relationName: keyof R,
    config: HasManyConfig,
    targetEntity: EntityDefinition<any>,
  ): Promise<void> {
    const ids = entities.map(e => e.id as number)
    const relatedRepo = new Repository(targetEntity, undefined, this.orm)

    const related = await relatedRepo.query()
      .whereIn(config.foreignKey as any, ids as any)
      .execute()

    const grouped = new Map<number, any[]>()

    for (const item of related) {
      const fk = (item as any)[config.foreignKey]

      if (!grouped.has(fk))
        grouped.set(fk, [])

      grouped.get(fk)!.push(item)
    }

    for (const entity of entities) {
      (entity as any)[relationName] = grouped.get(entity.id as number) || []
    }
  }

  private async loadBelongsTo(
    entities: InferEntity<T>[],
    relationName: keyof R,
    config: BelongsToConfig,
    targetEntity: EntityDefinition<any>,
  ): Promise<void> {
    const foreignKeys = entities
      .map(e => (e as any)[config.foreignKey])
      .filter((fk): fk is number => fk != null)

    if (foreignKeys.length === 0) {
      for (const entity of entities) {
        (entity as any)[relationName] = null
      }

      return
    }

    const relatedRepo = new Repository(targetEntity, undefined, this.orm)
    const ownerKey = config.ownerKey || 'id'

    const related = await relatedRepo.query()
      .whereIn(ownerKey as any, foreignKeys as any)
      .execute()

    const lookupMap = new Map(
      related.map(item => [(item as any)[ownerKey], item]),
    )

    for (const entity of entities) {
      const foreignKeyValue = (entity as any)[config.foreignKey] as number | null

      (entity as any)[relationName] = foreignKeyValue != null ? lookupMap.get(foreignKeyValue) || null : null
    }
  }

  private async loadHasOne(
    entities: InferEntity<T>[],
    relationName: keyof R,
    config: HasOneConfig,
    targetEntity: EntityDefinition<any>,
  ): Promise<void> {
    const ids = entities.map(e => e.id as number)
    const relatedRepo = new Repository(targetEntity, undefined, this.orm)

    const related = await relatedRepo.query()
      .whereIn(config.foreignKey as any, ids as any)
      .execute()

    const lookupMap = new Map<number, any>()

    for (const item of related) {
      const fk = (item as any)[config.foreignKey]

      if (!lookupMap.has(fk)) {
        lookupMap.set(fk, item)
      }
    }

    for (const entity of entities) {
      (entity as any)[relationName] = lookupMap.get(entity.id as number) || null
    }
  }

  private async loadManyToMany(
    entities: InferEntity<T>[],
    relationName: keyof R,
    config: ManyToManyConfig,
    targetEntity: EntityDefinition<any>,
  ): Promise<void> {
    const ids = entities.map(e => e.id as number)

    const throughForeignKeyColumn = toSnake(config.throughForeignKey)
    const otherKeyColumn = toSnake(config.otherKey)

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    const junctionRows = await this.db.unsafe(
      `SELECT ${throughForeignKeyColumn}, ${otherKeyColumn}
       FROM ${config.through}
       WHERE ${throughForeignKeyColumn} IN (${placeholders})`,
      ids as any,
    )

    const relatedIds = [...new Set(junctionRows.map((r: any) => r[otherKeyColumn] as number))]

    if (relatedIds.length === 0) {
      for (const entity of entities) {
        (entity as any)[relationName] = []
      }

      return
    }

    const relatedRepo = new Repository(targetEntity, undefined, this.orm)
    const related = await relatedRepo.query()
      .whereIn('id', relatedIds as any)
      .execute()

    const relatedMap = new Map(related.map(item => [item.id as number, item]))

    const grouped = new Map<number, any[]>()

    for (const row of junctionRows) {
      const sourceId = (row as any)[throughForeignKeyColumn]
      const targetId = (row as any)[otherKeyColumn]
      const relatedEntity = relatedMap.get(targetId)

      if (relatedEntity) {
        if (!grouped.has(sourceId))
          grouped.set(sourceId, [])

        grouped.get(sourceId)!.push(relatedEntity)
      }
    }

    for (const entity of entities) {
      (entity as any)[relationName] = grouped.get(entity.id as number) || []
    }
  }
}

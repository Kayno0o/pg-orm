import type {
  DatabaseRow,
  EntityDefinition,
  EntitySchema,
  InferEntity,
} from './types'
import { parsePostgresArray } from './utils/array-parser'

export class EntityMapper<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
> {
  private schema: T
  private definition: EntityDefinition<T, TTraits>
  private fieldConfigs: { fieldName: string, columnName: string, config: any }[]
  private reverseColumnMap: Map<string, string>
  private entityPrototype: any

  constructor(
    schema: T,
    definition: EntityDefinition<T, TTraits>,
    fieldConfigs: { fieldName: string, columnName: string, config: any }[],
    reverseColumnMap: Map<string, string>,
    entityPrototype: any,
  ) {
    this.schema = schema
    this.definition = definition
    this.fieldConfigs = fieldConfigs
    this.reverseColumnMap = reverseColumnMap
    this.entityPrototype = entityPrototype
  }

  mapRowToEntity(row: DatabaseRow): InferEntity<T, TTraits> {
    const entity: any = Object.create(this.entityPrototype)

    entity.id = row.id

    for (const { fieldName, columnName, config } of this.fieldConfigs) {
      const value = row[columnName]

      if (value === undefined)
        continue

      if (config.type === 'array' && value !== null) {
        if (Array.isArray(value)) {
          entity[fieldName] = value
        }
        else if (typeof value === 'string') {
          entity[fieldName] = parsePostgresArray(value, config.arrayType as 'string' | 'number' | 'boolean')
        }
        else {
          entity[fieldName] = Array.from(value as any)
        }
      }
      else if ((config.type === 'timestamp' || config.type === 'date') && value !== null) {
        entity[fieldName] = value instanceof Date ? value : new Date(value as string)
      }
      else {
        entity[fieldName] = value
      }
    }

    return entity as InferEntity<T, TTraits>
  }
}

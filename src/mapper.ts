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
  private fieldConfigs: { fieldName: string, columnName: string, config: any }[]
  private entityPrototype: any
  private mapperFunction: (row: DatabaseRow, prototype: any, parsePostgresArray: any) => InferEntity<T, TTraits>

  constructor(
    definition: EntityDefinition<T, TTraits>,
    entityPrototype: any,
  ) {
    this.fieldConfigs = definition.metadata.getFieldToColumnMappings() as any
    this.entityPrototype = entityPrototype
    this.mapperFunction = this.compileMapper()
  }

  private compileMapper(): (row: DatabaseRow, prototype: any, parsePostgresArray: any) => InferEntity<T, TTraits> {
    let body = 'const entity = Object.create(prototype);\n'

    body += 'entity.id = row.id;\n'
    let i = 0

    for (const { fieldName, columnName, config } of this.fieldConfigs) {
      const f = JSON.stringify(fieldName)
      const c = JSON.stringify(columnName)
      const valVar = `v${i++}`

      body += `const ${valVar} = row[${c}];\n`
      body += `if (${valVar} !== undefined) {\n`

      if (config.type === 'array') {
        body += `  if (${valVar} === null) {\n`
        body += `    entity[${f}] = null;\n`
        body += `  } else if (Array.isArray(${valVar})) {\n`
        body += `    entity[${f}] = ${valVar};\n`
        body += `  } else if (typeof ${valVar} === 'string') {\n`
        body += `    entity[${f}] = parsePostgresArray(${valVar}, ${JSON.stringify(config.arrayType)});\n`
        body += `  } else {\n`
        body += `    entity[${f}] = Array.from(${valVar});\n`
        body += `  }\n`
      }
      else if (config.type === 'timestamp' || config.type === 'date') {
        body += `  if (${valVar} === null) {\n`
        body += `    entity[${f}] = null;\n`
        body += `  } else {\n`
        body += `    entity[${f}] = ${valVar} instanceof Date ? ${valVar} : new Date(${valVar});\n`
        body += `  }\n`
      }
      else {
        body += `  entity[${f}] = ${valVar};\n`
      }

      body += '}\n'
    }

    body += 'return entity;'

    try {
      // Use new Function to compile a specialized mapper for this entity schema.
      // This is a common performance optimization for hot paths in ORMs/Serializers.
      // eslint-disable-next-line no-new-func
      return new Function('row', 'prototype', 'parsePostgresArray', body) as any
    }
    catch {
      // Fallback to interpreted mapper if compilation fails (e.g. CSP)
      return (row: DatabaseRow, prototype: any, parsePostgresArray: any) => {
        const entity: any = Object.create(prototype)

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
              entity[fieldName] = parsePostgresArray(value, config.arrayType)
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

        return entity
      }
    }
  }

  mapRowToEntity(row: DatabaseRow): InferEntity<T, TTraits> {
    return this.mapperFunction(row, this.entityPrototype, parsePostgresArray)
  }
}

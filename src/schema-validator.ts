import type { EntitySchema } from './types'
import { ValidationError, Validator } from './validation'

const DEFAULT_JSON_DEPTH = 32

export class SchemaValidator<T extends EntitySchema> {
  private schema: T
  private tableName: string
  private validatorCache: Map<number, Validator>
  private defaultValidator: Validator

  constructor(schema: T, tableName: string) {
    this.schema = schema
    this.tableName = tableName
    this.validatorCache = new Map()
    this.defaultValidator = new Validator({ maxJsonDepth: DEFAULT_JSON_DEPTH })
  }

  getValidator(jsonDepth: number = DEFAULT_JSON_DEPTH): Validator {
    if (jsonDepth === DEFAULT_JSON_DEPTH) {
      return this.defaultValidator
    }

    let cached = this.validatorCache.get(jsonDepth)

    if (!cached) {
      cached = new Validator({ maxJsonDepth: jsonDepth })
      this.validatorCache.set(jsonDepth, cached)
    }

    return cached
  }

  validateCreate(data: Record<string, unknown>, jsonDepth?: number): void {
    const validator = this.getValidator(jsonDepth)

    validator.validate(data, this.schema, 'create', this.tableName)

    if (validator.hasErrors()) {
      throw new ValidationError(
        `Validation failed for ${this.tableName}`,
        validator.getErrors(),
        this.tableName,
      )
    }
  }

  validateUpdate(data: Record<string, unknown>, jsonDepth?: number): void {
    const validator = this.getValidator(jsonDepth)

    validator.validate(data, this.schema, 'update', this.tableName)

    if (validator.hasErrors()) {
      throw new ValidationError(
        `Validation failed for ${this.tableName}`,
        validator.getErrors(),
        this.tableName,
      )
    }
  }

  clearCache(): void {
    this.validatorCache.clear()
  }
}

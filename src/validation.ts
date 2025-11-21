import type {
  BooleanFieldConfig,
  EntitySchema,
  EnumFieldConfig,
  FieldConfig,
  NumberFieldConfig,
  StringFieldConfig,
  ValidationErrorDetail,
} from './types'

// ============================================================================
// Validation Layer
// ============================================================================

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ValidationErrorDetail[],
    public readonly tableName?: string,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

// Pre-compiled regex for UUID validation
const UUID_REGEX = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

export class Validator {
  private errors: ValidationErrorDetail[] = []

  // ========================================================================
  // Validate Single Field
  // ========================================================================

  validateField(fieldName: string, value: unknown, fieldConfig: FieldConfig): void {
    // Check nullable constraints
    if (value === null || value === undefined) {
      if (!fieldConfig.nullable && fieldConfig.default === undefined) {
        this.addError(fieldName, 'required', `Field "${fieldName}" is required`, value)
      }

      return // No further validation needed for null/undefined
    }

    // Type-specific validation
    switch (fieldConfig.type) {
    case 'string':
      this.validateString(fieldName, value, fieldConfig as StringFieldConfig)

      break
    case 'number':
      this.validateNumber(fieldName, value, fieldConfig as NumberFieldConfig)

      break
    case 'boolean':
      this.validateBoolean(fieldName, value, fieldConfig as BooleanFieldConfig)

      break
    case 'enum':
      this.validateEnum(fieldName, value, fieldConfig as EnumFieldConfig)

      break
    case 'uuid':
      this.validateUuid(fieldName, value)

      break
    case 'array':
      this.validateArray(fieldName, value)

      break
    case 'json':
    case 'jsonb':
      this.validateJson(fieldName, value)

      break
    case 'date':
    case 'timestamp':
      this.validateDate(fieldName, value)

      break
    case 'blob':
      this.validateBlob(fieldName, value)

      break
    }
  }

  // ========================================================================
  // Type-Specific Validators
  // ========================================================================

  private validateString(fieldName: string, value: unknown, config: StringFieldConfig): void {
    if (typeof value !== 'string') {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a string`, value)

      return
    }

    if (config.maxLength !== undefined && value.length > config.maxLength) {
      this.addError(
        fieldName,
        'maxLength',
        `Field "${fieldName}" exceeds maximum length of ${config.maxLength} (got ${value.length})`,
        value,
      )
    }

    if (config.minLength !== undefined && value.length < config.minLength) {
      this.addError(
        fieldName,
        'minLength',
        `Field "${fieldName}" is below minimum length of ${config.minLength} (got ${value.length})`,
        value,
      )
    }
  }

  private validateNumber(fieldName: string, value: unknown, config: NumberFieldConfig): void {
    const numValue = Number(value)

    if (Number.isNaN(numValue)) {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a number`, value)

      return
    }

    if (config.integer && !Number.isInteger(numValue)) {
      this.addError(fieldName, 'integer', `Field "${fieldName}" must be an integer`, value)
    }

    if (config.min !== undefined && numValue < config.min) {
      this.addError(
        fieldName,
        'min',
        `Field "${fieldName}" is below minimum value of ${config.min} (got ${numValue})`,
        value,
      )
    }

    if (config.max !== undefined && numValue > config.max) {
      this.addError(
        fieldName,
        'max',
        `Field "${fieldName}" exceeds maximum value of ${config.max} (got ${numValue})`,
        value,
      )
    }
  }

  private validateBoolean(fieldName: string, value: unknown, _config: BooleanFieldConfig): void {
    if (typeof value !== 'boolean') {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a boolean`, value)
    }
  }

  private validateEnum(fieldName: string, value: unknown, config: EnumFieldConfig): void {
    if (typeof value !== 'string') {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a string`, value)

      return
    }

    if (!config.values.includes(value)) {
      this.addError(
        fieldName,
        'enum',
        `Field "${fieldName}" must be one of: ${config.values.join(', ')} (got "${value}")`,
        value,
      )
    }
  }

  private validateUuid(fieldName: string, value: unknown): void {
    if (typeof value !== 'string') {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a string`, value)

      return
    }

    if (!UUID_REGEX.test(value)) {
      this.addError(fieldName, 'format', `Field "${fieldName}" must be a valid UUID`, value)
    }
  }

  private validateArray(fieldName: string, value: unknown): void {
    if (!Array.isArray(value)) {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be an array`, value)
    }
  }

  private validateJson(fieldName: string, value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be an object`, value)
    }
  }

  private validateDate(fieldName: string, value: unknown): void {
    if (!(value instanceof Date)) {
      const dateValue = new Date(value as any)

      if (Number.isNaN(dateValue.getTime())) {
        this.addError(fieldName, 'type', `Field "${fieldName}" must be a valid date`, value)
      }
    }
  }

  private validateBlob(fieldName: string, value: unknown): void {
    if (!(value instanceof Uint8Array)) {
      this.addError(fieldName, 'type', `Field "${fieldName}" must be a Uint8Array`, value)
    }
  }

  // ========================================================================
  // Validate Full Data Object
  // ========================================================================

  validate(data: Record<string, unknown>, schema: EntitySchema, operation: 'create' | 'update', tableName?: string): void {
    this.errors = []

    for (const [fieldName, fieldConfig] of Object.entries(schema)) {
      const value = data[fieldName]

      // For create operations, check required fields
      if (operation === 'create') {
        if (value === undefined && !fieldConfig.nullable && fieldConfig.default === undefined) {
          this.addError(fieldName, 'required', `Field "${fieldName}" is required`, value)

          continue
        }
      }

      // Skip validation if value is not provided in update
      if (operation === 'update' && value === undefined) {
        continue
      }

      this.validateField(fieldName, value, fieldConfig)
    }

    if (this.errors.length > 0) {
      const tableContext = tableName ? ` for table "${tableName}"` : ''

      throw new ValidationError(
        `Validation failed${tableContext} with ${this.errors.length} error(s)`,
        this.errors,
        tableName,
      )
    }
  }

  // ========================================================================
  // Error Management
  // ========================================================================

  private addError(field: string, constraint: string, message: string, value?: unknown): void {
    this.errors.push({
      field,
      constraint,
      message,
      value,
    })
  }

  getErrors(): ValidationErrorDetail[] {
    return this.errors
  }

  hasErrors(): boolean {
    return this.errors.length > 0
  }
}

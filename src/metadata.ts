type ClassConstructor = abstract new (...args: any[]) => any

export interface ColumnMetadata {
  propertyKey: string
  type: 'bool' | 'int' | 'float' | 'text' | 'blob' | 'json' | 'jsonb' | 'uuid' | 'timestamp' | 'array' | 'enum'
  nullable?: boolean
  unique?: boolean
  primary?: boolean
  default?: any
  name?: string
  reference?: {
    table: string
    key: string
  }
  autoUpdate?: boolean
  enumValues?: string[]
  arrayType?: 'text' | 'int' | 'float'
}

export interface EntityMetadata {
  tableName: string
  target: ClassConstructor
  columns: Map<string, ColumnMetadata>
  uniqueConstraints?: string[][]
}

const entityMetadataMap = new Map<ClassConstructor, EntityMetadata>()
const columnMetadataMap = new Map<ClassConstructor, Map<string, ColumnMetadata>>()

export function setEntityMetadata(target: ClassConstructor, metadata: EntityMetadata): void {
  entityMetadataMap.set(target, metadata)
}

export function getEntityMetadata(target: ClassConstructor): EntityMetadata | undefined {
  return entityMetadataMap.get(target)
}

export function setColumnMetadata(
  target: ClassConstructor,
  propertyKey: string,
  metadata: ColumnMetadata,
): void {
  let columns = columnMetadataMap.get(target)

  if (!columns) {
    columns = new Map()
    columnMetadataMap.set(target, columns)
  }

  columns.set(propertyKey, metadata)
}

export function getColumnMetadata(target: ClassConstructor): Map<string, ColumnMetadata> {
  return columnMetadataMap.get(target) || new Map()
}

export function getColumnMetadataByKey(
  target: ClassConstructor,
  propertyKey: string,
): ColumnMetadata | undefined {
  const columns = columnMetadataMap.get(target)

  return columns?.get(propertyKey)
}

export function getAllEntities(): EntityMetadata[] {
  return Array.from(entityMetadataMap.values())
}

export function mapColumnTypeToPostgres(
  type: ColumnMetadata['type'],
  metadata?: Partial<ColumnMetadata>,
): string {
  switch (type) {
  case 'int':
    return 'INTEGER'

  case 'float':
    return 'REAL'

  case 'bool':
    return 'BOOLEAN'

  case 'text':
    return 'TEXT'

  case 'blob':
    return 'BYTEA'

  case 'json':
    return 'JSON'

  case 'jsonb':
    return 'JSONB'

  case 'uuid':
    return 'UUID'

  case 'timestamp':
    return 'TIMESTAMP WITH TIME ZONE'

  case 'array': {
    const arrayType = metadata?.arrayType || 'text'
    const baseType = mapColumnTypeToPostgres(arrayType as any)

    return `${baseType}[]`
  }

  case 'enum':
    return 'TEXT'

  default:
    throw new Error(`Unsupported column type: ${type}`)
  }
}

export function clearMetadata(): void {
  entityMetadataMap.clear()
  columnMetadataMap.clear()
}

import type { AnyTableDef, IndexDef } from '../../types/index'
import type { LiveIndex, MigrationOp } from '../types'
import { buildCreateIndexSql, buildDropIndexSql, buildIndexName, normalizeExpression } from '../ddl'
import { WHERE_RE } from '../regex'

function collectDesiredIndexes(desired: ReadonlyMap<string, AnyTableDef>): Map<string, { tableName: string, idx: IndexDef }> {
  const result = new Map<string, { tableName: string, idx: IndexDef }>()

  for (const [tableName, tableDef] of desired) {
    const indexes = tableDef.indexes ?? []

    for (const idx of indexes) {
      const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)

      result.set(name, { tableName, idx })
    }
  }

  return result
}

function indexChanged(liveIdx: LiveIndex, idx: IndexDef, tableName: string): boolean {
  // An index on expressions, sorted, with operator classes or included columns compares as the definition Postgres prints back, from its method on.
  if (idx.expressions?.length || idx.desc?.length || idx.include?.length || Object.keys(idx.opclass ?? {}).length) {
    const desired = buildCreateIndexSql(tableName, idx)

    return (idx.unique ?? false) !== liveIdx.isUnique
      || normalizeExpression(desired.slice(desired.indexOf(' USING '))) !== normalizeExpression(liveIdx.definition.slice(liveIdx.definition.indexOf(' USING ')))
  }

  const desiredMethod = idx.method ?? 'btree'

  if (liveIdx.method !== desiredMethod)
    return true

  const desiredCols = idx.columns
  const liveCols = liveIdx.columns

  if (desiredCols.length !== liveCols.length || desiredCols.some((c, i) => c !== liveCols[i]))
    return true

  if ((idx.unique ?? false) !== liveIdx.isUnique)
    return true

  const whereIdx = liveIdx.definition.search(WHERE_RE)
  const liveWhere = whereIdx >= 0 ? liveIdx.definition.slice(whereIdx + 6).trim() : undefined

  if (normalizeExpression(idx.where) !== normalizeExpression(liveWhere))
    return true

  return false
}

export function diffIndexes(
  desired: ReadonlyMap<string, AnyTableDef>,
  liveIndexes: LiveIndex[],
  droppedTables: Set<string>,
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const desiredIndexes = collectDesiredIndexes(desired)
  const liveIndexMap = new Map(liveIndexes.map(i => [i.name, i]))

  for (const [name, { tableName, idx }] of desiredIndexes) {
    if (liveIndexMap.has(name)) {
      const liveIdx = liveIndexMap.get(name)!

      if (indexChanged(liveIdx, idx, tableName)) {
        ops.push({
          type: 'drop_index',
          table: tableName,
          sql: buildDropIndexSql(name),
          destructive: true,
          description: `Drop index "${name}" from "${tableName}" (changed)`,
        })
        ops.push({
          type: 'create_index',
          table: tableName,
          sql: buildCreateIndexSql(tableName, idx),
          destructive: false,
          description: `Recreate index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
        })
      }

      liveIndexMap.delete(name)

      continue
    }

    ops.push({
      type: 'create_index',
      table: tableName,
      sql: buildCreateIndexSql(tableName, idx),
      destructive: false,
      description: `Create index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
    })
  }

  for (const [name, liveIdx] of liveIndexMap) {
    if (!desired.has(liveIdx.tableName))
      continue

    if (droppedTables.has(liveIdx.tableName))
      continue

    ops.push({
      type: 'drop_index',
      table: liveIdx.tableName,
      sql: buildDropIndexSql(name),
      destructive: true,
      description: `Drop index "${name}" from "${liveIdx.tableName}"`,
    })
  }

  return ops
}

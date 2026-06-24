import type { AnyTableDef, IndexDef } from '../../types/index'
import type { LiveIndex, MigrationOp } from '../types'
import { buildCreateIndexSql, buildDropIndexSql, buildIndexName } from '../ddl'
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

function indexChanged(liveIdx: LiveIndex, idx: IndexDef): boolean {
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
  const desiredWhere = idx.where?.trim()

  if ((desiredWhere ?? '') !== (liveWhere ?? ''))
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

      if (indexChanged(liveIdx, idx)) {
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

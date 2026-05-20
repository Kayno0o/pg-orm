import type { AnyTableDef, IndexDef } from '../../types/index'
import type { LiveIndex, MigrationOp } from '../types'
import { WHERE_RE } from '../regex'

function buildIndexName(tableName: string, columns: string[], unique: boolean): string {
  const suffix = unique ? 'unique' : 'idx'

  return `${tableName}_${columns.join('_')}_${suffix}`
}

function buildCreateIndexSql(tableName: string, idx: IndexDef): string {
  const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)
  const method = idx.method ?? 'btree'
  const unique = idx.unique ? 'UNIQUE ' : ''
  const cols = idx.columns.map(c => `"${c}"`).join(', ')
  let sql = `CREATE ${unique}INDEX "${name}" ON "${tableName}" USING ${method} (${cols})`

  if (idx.where) {
    sql += ` WHERE ${idx.where}`
  }

  return sql
}

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
  ops: MigrationOp[],
  desired: ReadonlyMap<string, AnyTableDef>,
  liveIndexes: LiveIndex[],
): void {
  const desiredIndexes = collectDesiredIndexes(desired)
  const liveIndexMap = new Map(liveIndexes.map(i => [i.name, i]))

  for (const [name, { tableName, idx }] of desiredIndexes) {
    if (liveIndexMap.has(name)) {
      const liveIdx = liveIndexMap.get(name)!

      if (indexChanged(liveIdx, idx)) {
        ops.push({
          type: 'drop_index',
          table: tableName,
          sql: `DROP INDEX "${name}"`,
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

    if (ops.some(o => o.type === 'drop_table' && o.table === liveIdx.tableName))
      continue

    ops.push({
      type: 'drop_index',
      table: liveIdx.tableName,
      sql: `DROP INDEX "${name}"`,
      destructive: true,
      description: `Drop index "${name}" from "${liveIdx.tableName}"`,
    })
  }
}

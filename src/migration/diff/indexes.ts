import type { AnyTableDef, IndexDef } from '../../types/index'
import type { LiveIndex, MigrationOp } from '../types'
import { buildCreateIndexSql, buildDropIndexSql, buildIndexName, claimIndexName, normalizeExpression } from '../ddl'
import { QUOTED_PARAM_RE, WHERE_RE } from '../regex'

function collectDesiredIndexes(desired: ReadonlyMap<string, AnyTableDef>): Map<string, { tableName: string, idx: IndexDef }> {
  const result = new Map<string, { tableName: string, idx: IndexDef }>()
  const taken = new Set<string>()

  for (const [tableName, tableDef] of desired) {
    const indexes = tableDef.indexes ?? []

    for (const idx of indexes) {
      const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)

      claimIndexName(taken, name, tableName)
      result.set(name, { tableName, idx })
    }
  }

  return result
}

// Postgres prints a storage parameter's value quoted (`m='16'`), the DDL writes it bare.
function comparableDefinition(definition: string): string {
  return normalizeExpression(definition.slice(definition.indexOf(' USING ')).replace(QUOTED_PARAM_RE, '$1=$2'))
}

function indexChanged(liveIdx: LiveIndex, idx: IndexDef, tableName: string): boolean {
  // An index on expressions, sorted, with operator classes or included columns compares as the definition Postgres prints back, from its method on.
  if (idx.expressions?.length || idx.desc?.length || idx.include?.length || idx.with || Object.keys(idx.opclass ?? {}).length) {
    const desired = buildCreateIndexSql(tableName, idx)

    return (idx.unique ?? false) !== liveIdx.isUnique
      || comparableDefinition(desired) !== comparableDefinition(liveIdx.definition)
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

/**
 * `liveTables` are the tables that exist before the migration: a `concurrently` index on one is built after the transaction commits, while one on a table the migration creates, empty, is built in it.
 * An index left invalid by a failed concurrent build is dropped and built again.
 */
export function diffIndexes(
  desired: ReadonlyMap<string, AnyTableDef>,
  liveIndexes: LiveIndex[],
  droppedTables: Set<string>,
  liveTables: ReadonlySet<string> = new Set(),
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const desiredIndexes = collectDesiredIndexes(desired)
  const liveIndexMap = new Map(liveIndexes.map(i => [i.name, i]))

  for (const [name, { tableName, idx }] of desiredIndexes) {
    const concurrent = idx.concurrently === true && liveTables.has(tableName)
    const outside = concurrent ? { outsideTransaction: true } : {}
    const liveIdx = liveIndexMap.get(name)

    if (liveIdx) {
      liveIndexMap.delete(name)

      if (liveIdx.isValid !== false && !indexChanged(liveIdx, idx, tableName))
        continue

      ops.push({
        type: 'drop_index',
        table: tableName,
        sql: buildDropIndexSql(name, concurrent),
        // An invalid index serves no query, so dropping it loses nothing.
        destructive: liveIdx.isValid !== false,
        description: `Drop index "${name}" from "${tableName}" (${liveIdx.isValid === false ? 'invalid' : 'changed'})`,
        ...outside,
      })
      ops.push({
        type: 'create_index',
        table: tableName,
        sql: buildCreateIndexSql(tableName, idx, concurrent),
        destructive: false,
        description: `Recreate index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
        ...outside,
      })

      continue
    }

    ops.push({
      type: 'create_index',
      table: tableName,
      sql: buildCreateIndexSql(tableName, idx, concurrent),
      destructive: false,
      description: `Create index "${name}" on "${tableName}" (${idx.columns.join(', ')})${concurrent ? ', concurrently' : ''}`,
      ...outside,
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

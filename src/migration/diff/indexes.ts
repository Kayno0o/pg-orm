import type { AnyTableDef, IndexDef } from '../../types/index'
import type { LiveIndex, MigrationOp } from '../types'
import { buildCreateIndexSql, buildDropIndexSql, buildIndexName, claimIndexName } from '../ddl'
import { looseExpression, sameExpression } from '../expression'
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

// An index definition cut into what comes before its predicate and the predicate.
function splitPredicate(definition: string): [string, string | undefined] {
  const at = definition.search(WHERE_RE)

  return at < 0 ? [definition, undefined] : [definition.slice(0, at), definition.slice(at + 5).trim()]
}

// Postgres prints a storage parameter's value quoted (`m='16'`), the DDL writes it bare.
function sameDefinition(desired: string, live: string): boolean {
  const [desiredHead, desiredWhere] = splitPredicate(desired)
  const [liveHead, liveWhere] = splitPredicate(live)
  const comparable = (head: string) => looseExpression(head.slice(head.indexOf(' USING ')).replace(QUOTED_PARAM_RE, '$1=$2'))

  return comparable(desiredHead) === comparable(liveHead) && sameExpression(desiredWhere, liveWhere)
}

// Postgres prints no operator class an index leaves at its type's default, so one the definition names as such is left out of the comparison.
function withoutDefaultOpclasses(idx: IndexDef, defaults: readonly string[]): IndexDef {
  const opclass = Object.fromEntries(Object.entries(idx.opclass ?? {}).filter(([, name]) => !defaults.includes(name)))

  return { ...idx, opclass }
}

function indexChanged(liveIdx: LiveIndex, idxDef: IndexDef, tableName: string): boolean {
  const idx = withoutDefaultOpclasses(idxDef, liveIdx.defaultOpclasses ?? [])

  // An index on expressions, sorted, with operator classes or included columns compares as the definition Postgres prints back, from its method on.
  if (idx.expressions?.length || idx.desc?.length || idx.include?.length || idx.with || Object.keys(idx.opclass ?? {}).length) {
    const desired = buildCreateIndexSql(tableName, idx)

    return (idx.unique ?? false) !== liveIdx.isUnique || !sameDefinition(desired, liveIdx.definition)
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

  return !sameExpression(idx.where, splitPredicate(liveIdx.definition)[1])
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

import type { ExprOp, ExprTape } from '../builder/_tape'
import type { AnyRelations, AnyTableDef } from '../types/index'
import { OP_EXISTS, OP_HAS, OP_NOT_EXISTS } from '../builder/_tape'
import { createExprBuilder } from '../builder/expr'
import { SelectBuilder } from '../builder/query'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { ValidationError } from '../errors/index'
import { liftedScopes, resolveScopes } from './table-behavior'

type Registry = ReadonlyMap<string, AnyTableDef> | undefined
type HasOp = Extract<ExprOp, { op: typeof OP_HAS }>

const e = createExprBuilder<any>()

function filterName(op: HasOp): string {
  return op.negate ? 'doesntHave' : 'has'
}

// A table outside the registry has no known scopes, so a soft-deleted related row would still count.
function registered(registry: Registry, name: string, op: HasOp): AnyTableDef {
  const table = registry?.get(name)

  if (!table)
    throw new ValidationError(`${filterName(op)}("${op.relation}"): "${name}" is not in the database's tables: list it in config.tables.`, 'has', { field: op.relation })

  return table
}

function singleKey(table: AnyTableDef, op: HasOp): string {
  const pk = table.primaryKey ?? DEFAULT_PRIMARY_KEY

  if (pk.includes(','))
    throw new ValidationError(`${filterName(op)}("${op.relation}"): "${table.name}" has a composite primary key (${pk}), which a relation filter cannot join on.`, 'has', { field: op.relation })

  return pk
}

/** `tape` with each `has()` and `doesntHave()` made a correlated `EXISTS` on the relation's table, `outer` naming the row of `table` it correlates with. */
export function resolveRelationFilters(tape: ExprTape, table: AnyTableDef, outer: string, registry: Registry, depth = 0): ExprTape {
  if (!tape.some(op => op.op === OP_HAS))
    return tape

  return tape.map(op => op.op === OP_HAS ? relationExists(op, table, outer, registry, depth) : op)
}

// The related table is aliased per nesting depth, so a self-relation's subquery still reaches the outer row by its table name.
function relationExists(op: HasOp, table: AnyTableDef, outer: string, registry: Registry, depth: number): ExprOp {
  const rel = (table.relations as AnyRelations | undefined)?.[op.relation]

  if (!rel)
    throw new ValidationError(`${filterName(op)}(): "${table.name}" has no relation "${op.relation}".`, 'has', { field: op.relation })

  const target = registered(registry, rel.targetTable, op)
  const alias = `__has${depth}`
  const query = new SelectBuilder<any, any>(target.name).as(alias).asExists().withoutScope(...liftedScopes(op.scopes))
  const state = query.getState()
  let link: ExprTape

  state.tableColumns = Object.keys(target.columns)
  state.scopes = resolveScopes(target, alias)

  if (rel.type === 'belongsTo') {
    link = e.eq(`${alias}.${singleKey(target, op)}`, e.ref(`${outer}.${rel.foreignKey}`))
  }
  else if (rel.type === 'hasManyThrough') {
    const pivot = registered(registry, rel.throughTable!, op)
    const via = `${alias}_pivot`

    query.join(pivot.name, via, j => j.eq(`${alias}.${singleKey(target, op)}`, j.ref(`${via}.${rel.throughTo!}`)))
    state.scopes.push(...resolveScopes(pivot, via))
    link = e.eq(`${via}.${rel.throughFrom!}`, e.ref(`${outer}.${singleKey(table, op)}`))
  }
  else {
    link = e.eq(`${alias}.${rel.foreignKey}`, e.ref(`${outer}.${singleKey(table, op)}`))
  }

  const where = op.where && resolveRelationFilters(op.where(e), target, alias, registry, depth + 1)

  state.whereTape = where ? e.and(link, where) : link

  return { op: op.negate ? OP_NOT_EXISTS : OP_EXISTS, subquery: query }
}

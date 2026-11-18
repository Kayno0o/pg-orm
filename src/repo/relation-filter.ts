import type { ExprOp, ExprTape } from '../builder/_tape'
import type { AnyRelations, AnyTableDef } from '../types/index'
import type { ScopeResolver } from './table-behavior'
import { OP_EXISTS, OP_HAS, OP_NOT_EXISTS } from '../builder/_tape'
import { createExprBuilder } from '../builder/expr'
import { SelectBuilder } from '../builder/query'

import { ValidationError } from '../errors/index'
import { singleKey } from '../schema/inspect'
import { liftedScopes, resolveScopes } from './table-behavior'

type Registry = ReadonlyMap<string, AnyTableDef> | undefined

const e = createExprBuilder<any>()

/** What a relation subquery is built from; `caller` names the method in errors. */
export interface RelationSubqueryInput {
  table: AnyTableDef
  relation: string
  /** The row of `table` the subquery correlates with: its alias, else its table name. */
  outer: string
  registry: Registry
  caller: string
  where?: ExprTape | null
  lifted: string[]
  depth: number
}

export interface RelationSubquery {
  query: SelectBuilder<any, any>
  target: AnyTableDef
  alias: string
}

// A table outside the registry has no known scopes, so a soft-deleted related row would still be reached.
function registered(input: RelationSubqueryInput, name: string): AnyTableDef {
  const table = input.registry?.get(name)

  if (!table)
    throw new ValidationError(`${input.caller}("${input.relation}"): "${name}" is not in the database's tables: list it in config.tables.`, input.caller, { field: input.relation })

  return table
}

/**
 * A SELECT over the relation's rows correlated with the outer row, selecting nothing yet. The target is aliased per nesting depth, so a self-relation still reaches the outer row by its table name.
 * A hasManyThrough joins its pivot; the target's and the pivot's scopes apply unless lifted, and `where` is ANDed on, its own relation filters resolved one level deeper.
 */
export function relationSubquery(input: RelationSubqueryInput): RelationSubquery {
  const { table, relation, outer, depth } = input
  const rel = (table.relations as AnyRelations | undefined)?.[relation]

  if (!rel)
    throw new ValidationError(`${input.caller}(): "${table.name}" has no relation "${relation}".`, input.caller, { field: relation })

  const target = registered(input, rel.targetTable)
  const alias = `__rel${depth}`
  const query = new SelectBuilder<any, any>(target.name).as(alias).withoutScope(...input.lifted)
  const state = query.getState()
  let link: ExprTape

  state.tableColumns = Object.keys(target.columns)
  state.scopes = resolveScopes(target, alias, scopeResolver(target, input.registry, depth + 1))

  if (rel.type === 'belongsTo') {
    link = e.eq(`${alias}.${singleKey(target, input.caller, input.relation)}`, e.ref(`${outer}.${rel.foreignKey}`))
  }
  else if (rel.type === 'hasManyThrough') {
    const pivot = registered(input, rel.throughTable!)
    const via = `${alias}_pivot`

    query.join(pivot.name, via, j => j.eq(`${alias}.${singleKey(target, input.caller, input.relation)}`, j.ref(`${via}.${rel.throughTo!}`)))
    state.scopes.push(...resolveScopes(pivot, via, scopeResolver(pivot, input.registry, depth + 1)))
    link = e.eq(`${via}.${rel.throughFrom!}`, e.ref(`${outer}.${singleKey(table, input.caller, input.relation)}`))
  }
  else {
    link = e.eq(`${alias}.${rel.foreignKey}`, e.ref(`${outer}.${singleKey(table, input.caller, input.relation)}`))
  }

  const where = input.where && resolveRelationFilters(input.where, target, alias, input.registry, depth + 1)

  state.whereTape = where ? e.and(link, where) : link

  return { query, target, alias }
}

/** The resolver for the scopes of `table`: their relation filters read through `registry`, `depth` levels down. */
export function scopeResolver(table: AnyTableDef, registry: Registry, depth = 0): ScopeResolver {
  return (tape, outer) => resolveRelationFilters(tape, table, outer, registry, depth)
}

/** `tape` with each `has()` and `doesntHave()` made a correlated `EXISTS` on the relation's table, `outer` naming the row of `table` it correlates with. */
export function resolveRelationFilters(tape: ExprTape, table: AnyTableDef, outer: string, registry: Registry, depth = 0): ExprTape {
  if (!tape.some(op => op.op === OP_HAS))
    return tape

  return tape.map((op): ExprOp => {
    if (op.op !== OP_HAS)
      return op

    const caller = op.negate ? 'doesntHave' : 'has'
    const { query } = relationSubquery({ table, relation: op.relation, outer, registry, caller, where: op.where?.(e), lifted: liftedScopes(op.scopes), depth })

    return { op: op.negate ? OP_NOT_EXISTS : OP_EXISTS, subquery: query.asExists() }
  })
}

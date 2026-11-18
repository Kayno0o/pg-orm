import type { AnyColumns } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import type { TableTarget } from './state'
import { ValidationError } from '../errors/index'
import { validateIdentifier } from '../schema/validate'
import { MutationBuilder } from './base'
import { createExprBuilder } from './expr'
import { columnValues, validateValues } from './state'

function requireValues(values: Record<string, unknown>, context: string): void {
  validateValues(values, context)

  if (Object.keys(values).length === 0)
    throw new ValidationError(`${context}: name at least one column to write.`, context)
}

export class MergeBuilder<TColumns extends AnyColumns> extends MutationBuilder {
  constructor(table: TableTarget) {
    super('merge', table)
  }

  using(sourceTable: string, alias: string): this {
    validateIdentifier(sourceTable, 'merge source table')
    validateIdentifier(alias, 'merge source alias')
    this._state.joins.push({ type: 'inner', table: sourceTable, alias, on: null })

    return this
  }

  on(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeOn = fn(builder)

    return this
  }

  whenMatched(_action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    requireValues(values, 'MergeBuilder.whenMatched()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'matched',
      action: 'update',
      values: columnValues(values, this._state.columnDefs),
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenMatchedDelete(condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'matched',
      action: 'delete',
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatched(_action: 'insert', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    requireValues(values, 'MergeBuilder.whenNotMatched()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched',
      action: 'insert',
      values: columnValues(values, this._state.columnDefs),
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatchedBySource(_action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    requireValues(values, 'MergeBuilder.whenNotMatchedBySource()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched_by_source',
      action: 'update',
      values: columnValues(values, this._state.columnDefs),
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatchedBySourceDelete(condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched_by_source',
      action: 'delete',
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  returning(): MergeBuilder<TColumns>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): MergeBuilder<TColumns>
  returning(...cols: string[]): MergeBuilder<TColumns> {
    return this._setReturning(cols) as never
  }
}

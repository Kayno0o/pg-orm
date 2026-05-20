import type { AnyColumns } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import { MutationBuilder } from './base'
import { createExprBuilder } from './expr'
import { validateValues } from './state'

export class MergeBuilder<TColumns extends AnyColumns> extends MutationBuilder {
  constructor(table: string) {
    super('merge', table)
  }

  using(sourceTable: string, alias: string): this {
    this._state.joins.push({ type: 'inner', table: sourceTable, alias, on: null })

    return this
  }

  on(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeOn = fn(builder)

    return this
  }

  whenMatched(_action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    validateValues(values, 'MergeBuilder.whenMatched()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'matched',
      action: 'update',
      values,
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
    validateValues(values, 'MergeBuilder.whenNotMatched()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched',
      action: 'insert',
      values,
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatchedBySource(_action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    validateValues(values, 'MergeBuilder.whenNotMatchedBySource()')

    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched_by_source',
      action: 'update',
      values,
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

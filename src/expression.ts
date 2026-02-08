import type { EntitySchema, SQLValue, StringLikeFieldKeys, WhereValueForKey } from './types'

type AddParam = (value: SQLValue) => string
type ResolveColumn = (field: string) => string

export type ExpressionNode<T extends EntitySchema>
  = | { type: 'comparison', field: string, operator: string, value: SQLValue }
    | { type: 'in', field: string, values: SQLValue[], negated: boolean }
    | { type: 'null', field: string, negated: boolean }
    | { type: 'between', field: string, min: SQLValue, max: SQLValue }
    | { type: 'and', children: Expression<T>[] }
    | { type: 'or', children: Expression<T>[] }
    | { type: 'not', child: Expression<T> }

export class Expression<T extends EntitySchema> {
  readonly _brand = 'Expression' as const

  constructor(readonly node: ExpressionNode<T>) {}

  _apply(addParam: AddParam, resolveColumn: ResolveColumn): string {
    const { node } = this

    switch (node.type) {
    case 'comparison': {
      const col = resolveColumn(node.field)
      const param = addParam(node.value)

      return `${col} ${node.operator} ${param}`
    }

    case 'in': {
      if (node.values.length === 0) {
        return node.negated ? 'TRUE' : 'FALSE'
      }

      const col = resolveColumn(node.field)
      const placeholders = node.values.map(v => addParam(v)).join(', ')
      const op = node.negated ? 'NOT IN' : 'IN'

      return `${col} ${op} (${placeholders})`
    }

    case 'null': {
      const col = resolveColumn(node.field)

      return node.negated ? `${col} IS NOT NULL` : `${col} IS NULL`
    }

    case 'between': {
      const col = resolveColumn(node.field)
      const minParam = addParam(node.min)
      const maxParam = addParam(node.max)

      return `${col} BETWEEN ${minParam} AND ${maxParam}`
    }

    case 'and': {
      if (node.children.length === 0)
        return 'TRUE'

      if (node.children.length === 1)
        return node.children[0]!._apply(addParam, resolveColumn)

      const parts = node.children.map(c => c._apply(addParam, resolveColumn))

      return `(${parts.join(' AND ')})`
    }

    case 'or': {
      if (node.children.length === 0)
        return 'FALSE'

      if (node.children.length === 1)
        return node.children[0]!._apply(addParam, resolveColumn)

      const parts = node.children.map(c => c._apply(addParam, resolveColumn))

      return `(${parts.join(' OR ')})`
    }

    case 'not': {
      const inner = node.child._apply(addParam, resolveColumn)

      return `NOT (${inner})`
    }
    }
  }
}

export class ExpressionBuilder<T extends EntitySchema> {
  eq<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '=', value: value as SQLValue })
  }

  neq<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '!=', value: value as SQLValue })
  }

  gt<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '>', value: value as SQLValue })
  }

  gte<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '>=', value: value as SQLValue })
  }

  lt<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '<', value: value as SQLValue })
  }

  lte<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: '<=', value: value as SQLValue })
  }

  like(field: StringLikeFieldKeys<T> | 'id', pattern: string): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: 'LIKE', value: pattern })
  }

  ilike(field: StringLikeFieldKeys<T> | 'id', pattern: string): Expression<T> {
    return new Expression({ type: 'comparison', field: String(field), operator: 'ILIKE', value: pattern })
  }

  in<K extends keyof T | 'id'>(field: K, values: WhereValueForKey<T, K>[]): Expression<T> {
    return new Expression({ type: 'in', field: String(field), values: values as SQLValue[], negated: false })
  }

  notIn<K extends keyof T | 'id'>(field: K, values: WhereValueForKey<T, K>[]): Expression<T> {
    return new Expression({ type: 'in', field: String(field), values: values as SQLValue[], negated: true })
  }

  isNull(field: keyof T | 'id'): Expression<T> {
    return new Expression({ type: 'null', field: String(field), negated: false })
  }

  isNotNull(field: keyof T | 'id'): Expression<T> {
    return new Expression({ type: 'null', field: String(field), negated: true })
  }

  between<K extends keyof T | 'id'>(field: K, min: WhereValueForKey<T, K>, max: WhereValueForKey<T, K>): Expression<T> {
    return new Expression({ type: 'between', field: String(field), min: min as SQLValue, max: max as SQLValue })
  }

  and(...expressions: Expression<T>[]): Expression<T> {
    return new Expression({ type: 'and', children: expressions })
  }

  or(...expressions: Expression<T>[]): Expression<T> {
    return new Expression({ type: 'or', children: expressions })
  }

  not(expression: Expression<T>): Expression<T> {
    return new Expression({ type: 'not', child: expression })
  }
}

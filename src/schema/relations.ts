import type { AnyTableDef, RelationTypes } from '../types/index'
import { validateIdentifier } from './validate'

// Re-export the interface from types
export type { RelationTypes } from '../types/index'

type TableRef = string | (() => AnyTableDef)

// A thunk is read on first use rather than at definition time, so it survives circular imports the way `.references(() => Table)` does. Its name was validated by `defineTable`.
function withTableName<T extends object>(rel: T, key: 'targetTable' | 'throughTable', ref: TableRef, context: string): T {
  if (typeof ref === 'string') {
    validateIdentifier(ref, context)

    return Object.assign(rel, { [key]: ref })
  }

  return Object.defineProperty(rel, key, { get: () => ref().name, enumerable: true })
}

// Factory for simple relations (belongsTo, hasOne, hasMany) — identical structure
function simpleRelation<T extends 'belongsTo' | 'hasOne' | 'hasMany'>(type: T) {
  return (target: TableRef, foreignKey: string, _opts?: { nullable: boolean }) => {
    validateIdentifier(foreignKey, 'relation foreign key')

    return withTableName({ _kind: 'relation' as const, type, foreignKey }, 'targetTable', target, 'relation target table')
  }
}

// Runtime implementation of the relation type factory
export function createRelationTypes(): RelationTypes {
  return {
    belongsTo: simpleRelation('belongsTo'),
    hasOne: simpleRelation('hasOne'),
    hasMany: simpleRelation('hasMany'),

    hasManyThrough(target: TableRef, pivot: TableRef, opts: { from: string, to: string }) {
      validateIdentifier(opts.from, 'relation throughFrom')
      validateIdentifier(opts.to, 'relation throughTo')

      const rel = {
        _kind: 'relation' as const,
        type: 'hasManyThrough' as const,
        foreignKey: '',
        throughFrom: opts.from,
        throughTo: opts.to,
      }

      withTableName(rel, 'targetTable', target, 'relation target table')

      return withTableName(rel, 'throughTable', pivot, 'relation pivot table')
    },
  } as unknown as RelationTypes
}

import type { RelationTypes } from '../types/index'
import { validateIdentifier } from './validate'

// Re-export the interface from types
export type { RelationTypes } from '../types/index'

// Factory for simple relations (belongsTo, hasOne, hasMany) — identical structure
function simpleRelation<T extends 'belongsTo' | 'hasOne' | 'hasMany'>(type: T) {
  return (targetTable: string, foreignKey: string, _opts?: { nullable: boolean }) => {
    validateIdentifier(targetTable, 'relation target table')
    validateIdentifier(foreignKey, 'relation foreign key')

    return {
      _kind: 'relation' as const,
      type,
      targetTable,
      foreignKey,
    }
  }
}

// Runtime implementation of the relation type factory
export function createRelationTypes(): RelationTypes {
  return {
    belongsTo: simpleRelation('belongsTo'),
    hasOne: simpleRelation('hasOne'),
    hasMany: simpleRelation('hasMany'),

    hasManyThrough(targetTable, pivotTable, opts) {
      validateIdentifier(targetTable, 'relation target table')
      validateIdentifier(pivotTable, 'relation pivot table')
      validateIdentifier(opts.from, 'relation throughFrom')
      validateIdentifier(opts.to, 'relation throughTo')

      return {
        _kind: 'relation' as const,
        type: 'hasManyThrough' as const,
        targetTable,
        foreignKey: '',
        throughTable: pivotTable,
        throughFrom: opts.from,
        throughTo: opts.to,
      }
    },
  }
}

import type { RelationTypes } from '../types/index'

// Re-export the interface from types
export type { RelationTypes } from '../types/index'

// Runtime implementation of the relation type factory
export function createRelationTypes(): RelationTypes {
  return {
    belongsTo(targetTable, foreignKey) {
      return {
        _kind: 'relation' as const,
        type: 'belongsTo' as const,
        targetTable,
        foreignKey,
      }
    },

    hasOne(targetTable, foreignKey) {
      return {
        _kind: 'relation' as const,
        type: 'hasOne' as const,
        targetTable,
        foreignKey,
      }
    },

    hasMany(targetTable, foreignKey) {
      return {
        _kind: 'relation' as const,
        type: 'hasMany' as const,
        targetTable,
        foreignKey,
      }
    },

    hasManyThrough(targetTable, pivotTable, opts) {
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

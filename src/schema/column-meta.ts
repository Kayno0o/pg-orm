import type { AnyColumnDef } from '../types/index'

/**
 * Underscore-prefixed metadata attached to a frozen `ColumnDef`. These fields
 * are preserved through `ColumnBuilder._build()` so that the migration diff
 * and DDL layer can read them, but they are intentionally not part of the
 * exposed `ColumnDef` type to keep that surface narrow. Read them via
 * `getColumnMeta()` rather than re-casting.
 */
export interface ColumnDefMeta {
  enumName?: string
  enumValues?: readonly string[]
  index?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }
  renamedFrom?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  oneOf?: readonly (string | number)[]
}

export interface DefWithMeta {
  _enumName?: string
  _enumValues?: readonly string[]
  _index?: { method?: 'btree' | 'hash' | 'gin' | 'gist' | 'brin', where?: string }
  _renamedFrom?: string
  _min?: number
  _max?: number
  _minLength?: number
  _maxLength?: number
  _pattern?: string
  _oneOf?: readonly (string | number)[]
}

export function getColumnMeta(def: AnyColumnDef): ColumnDefMeta {
  const d = def as AnyColumnDef & DefWithMeta

  return {
    enumName: d._enumName,
    enumValues: d._enumValues,
    index: d._index,
    renamedFrom: d._renamedFrom,
    min: d._min,
    max: d._max,
    minLength: d._minLength,
    maxLength: d._maxLength,
    pattern: d._pattern,
    oneOf: d._oneOf,
  }
}

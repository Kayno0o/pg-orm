import type { IndexDef } from '../types/index'
import type { ColumnBuilder } from './columns'
import { getColumnIndex } from './columns'
import { validateIdentifier, validateRawSqlFragment } from './validate'

/** The index a column asked for with `.index()`, validated, or undefined when it asked for none. */
export function columnIndexDef(column: string, builder: ColumnBuilder): IndexDef | undefined {
  const idx = getColumnIndex(builder)

  if (!idx)
    return undefined

  if (idx.where !== undefined)
    validateRawSqlFragment(idx.where, `index on "${column}"`)

  if (idx.opclass !== undefined)
    validateIdentifier(idx.opclass, 'index operator class')

  return {
    columns: [column],
    unique: false,
    method: idx.method,
    where: idx.where,
    ...idx.concurrently ? { concurrently: true } : {},
    ...idx.opclass ? { opclass: { [column]: idx.opclass } } : {},
    ...idx.with ? { with: idx.with } : {},
  }
}

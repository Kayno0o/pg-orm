import type { SelectBuilder } from '../builder/query'
import type { Dialect } from '../dialect'
import type { RowMapper } from '../mapper/index'
import type { AnyTableDef } from '../types/index'
import { selectedColumns } from '../builder/state'
import { getOrCompileMapper } from '../mapper/index'

export type MapperFactory = (b: SelectBuilder<any, any, any>) => RowMapper<Record<string, unknown>>

export function createMapperFactory(table: AnyTableDef, dialect: Dialect = 'postgres'): MapperFactory {
  return (builder) => {
    const s = builder.getState()

    return getOrCompileMapper(
      table.name,
      table.columns,
      selectedColumns(s) ?? undefined,
      s.omitColumns.length ? s.omitColumns : undefined,
      s.computedColumns.length ? s.computedColumns.map(c => c.alias) : undefined,
      dialect,
    )
  }
}

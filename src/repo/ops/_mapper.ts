import type { SelectBuilder } from '../../builder/query'
import type { RowMapper } from '../../mapper/index'
import type { AnyTableDef } from '../../types/index'
import { getOrCompileMapper } from '../../mapper/index'

export type MapperFactory = (b: SelectBuilder<any, any, any>) => RowMapper<Record<string, unknown>>

export function createMapperFactory(table: AnyTableDef): MapperFactory {
  return (builder) => {
    const s = builder.getState()

    return getOrCompileMapper(
      table.name,
      table.columns,
      s.columns ?? undefined,
      s.omitColumns.length ? s.omitColumns : undefined,
    )
  }
}

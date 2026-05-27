import type { AnyTableDef } from '../../../../src/types/index'
import { createMapperFactory } from '../../../../src/repo/ops/_mapper'
import { RelationResolver } from '../../../../src/repo/relation-resolver'
import { buildTableRuntime } from '../../../../src/repo/table-runtime'
import { MockExecutor } from '../../../helpers/mock-executor'

export function setupOpEnv(table: AnyTableDef) {
  const exec = new MockExecutor()
  const rt = buildTableRuntime(table)
  const rel = new RelationResolver(table, exec, 5, 1000)
  const map = createMapperFactory(table)

  return { exec, rt, rel, map }
}

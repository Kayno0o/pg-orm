import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext } from '../../../../src/types/index'
import { createMapperFactory } from '../../../../src/repo/_mapper'
import { Repository } from '../../../../src/repo/index'
import { ReadPipeline } from '../../../../src/repo/read-pipeline'
import { RelationResolver } from '../../../../src/repo/relation-resolver'
import { buildTableRuntime } from '../../../../src/repo/table-runtime'
import { WritePipeline } from '../../../../src/repo/write-pipeline'
import { MockExecutor } from '../../../helpers/mock-executor'

export function setupOpEnv(table: AnyTableDef, tableRegistry?: ReadonlyMap<string, AnyTableDef>) {
  const exec = new MockExecutor()
  const rt = buildTableRuntime(table)
  const rel = new RelationResolver(table, exec, 5, 1000, tableRegistry)
  const map = createMapperFactory(table)
  const hooks: HookContext = { repo: other => new Repository({ table: other, executor: exec }) as never }

  return { exec, rt, rel, map, hooks }
}

export function setupReadPipeline(table: AnyTableDef, tableRegistry?: ReadonlyMap<string, AnyTableDef>) {
  const { exec, rt, rel, map, hooks } = setupOpEnv(table, tableRegistry)
  const pipeline = new ReadPipeline<AnyColumns, AnyRelations, AnyVirtuals>({
    executor: exec,
    runtime: rt,
    relations: rel,
    mapper: map,
    hooks,
    tableRegistry,
  })

  return { exec, rt, rel, map, pipeline }
}

export function setupWritePipeline(table: AnyTableDef) {
  const { exec, rt, hooks } = setupOpEnv(table)
  const pipeline = new WritePipeline({ executor: exec, runtime: rt, hooks })

  return { exec, rt, pipeline }
}

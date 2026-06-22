import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals } from '../../../../src/types/index'
import { createMapperFactory } from '../../../../src/repo/_mapper'
import { ReadPipeline } from '../../../../src/repo/read-pipeline'
import { RelationResolver } from '../../../../src/repo/relation-resolver'
import { buildTableRuntime } from '../../../../src/repo/table-runtime'
import { WritePipeline } from '../../../../src/repo/write-pipeline'
import { MockExecutor } from '../../../helpers/mock-executor'

export function setupOpEnv(table: AnyTableDef) {
  const exec = new MockExecutor()
  const rt = buildTableRuntime(table)
  const rel = new RelationResolver(table, exec, 5, 1000)
  const map = createMapperFactory(table)

  return { exec, rt, rel, map }
}

export function setupReadPipeline(table: AnyTableDef, tableRegistry?: ReadonlyMap<string, AnyTableDef>) {
  const { exec, rt, rel, map } = setupOpEnv(table)
  const pipeline = new ReadPipeline<AnyColumns, AnyRelations, AnyVirtuals>({
    executor: exec,
    runtime: rt,
    relations: rel,
    mapper: map,
    tableRegistry,
  })

  return { exec, rt, rel, map, pipeline }
}

export function setupWritePipeline(table: AnyTableDef) {
  const { exec, rt } = setupOpEnv(table)
  const pipeline = new WritePipeline({ executor: exec, runtime: rt })

  return { exec, rt, pipeline }
}

import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { defineTable, softDelete } from '../../../src/index'
import { setupReadPipeline } from './ops/_helpers'

const docs = defineTable('docs', t => ({
  id: t.serial().primaryKey(),
  tenant: t.text().notNull(),
  name: t.text().notNull(),
})).withScope('tenant', e => e.eq('tenant', 'acme')).withTrait(softDelete())

describe('finds take the scope options count takes', () => {
  it('findMany and findOne carry every scope, then lift one by name or withTrashed', async () => {
    const { exec, pipeline } = setupReadPipeline(docs)

    await pipeline.findMany({ name: 'a' })
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')
    expect(exec.lastQuery!.sql).toContain('"deletedAt" IS NULL')

    await pipeline.findMany({ name: 'a' }, { withoutScopes: ['tenant'] })
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')
    expect(exec.lastQuery!.sql).toContain('"deletedAt" IS NULL')

    await pipeline.findOne({ name: 'a' }, { withTrashed: true })
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')
    expect(exec.lastQuery!.sql).not.toContain('"deletedAt"')

    exec.preset([{ id: 1, tenant: 'x', name: 'n' }])
    await pipeline.findOneOrThrow(undefined, { withoutScopes: ['tenant'], withTrashed: true })
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')
    expect(exec.lastQuery!.sql).not.toContain('"deletedAt"')
  })

  it('findById and findByIdOrThrow take the options where a callback goes', async () => {
    const { exec, pipeline } = setupReadPipeline(docs)

    await pipeline.findById(1, { withTrashed: true })
    expect(exec.lastQuery!.sql).not.toContain('"deletedAt"')
    expect(exec.lastQuery!.sql).toContain('"tenant" = $')

    exec.preset([{ id: 1, tenant: 'x', name: 'n' }])
    await pipeline.findByIdOrThrow(1, { withoutScopes: ['tenant'] })
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')

    await pipeline.findById(1, q => q.withoutScope('tenant'))
    expect(exec.lastQuery!.sql).not.toContain('"tenant"')
  })

  it('refuses withoutScopes that is not an array of names', async () => {
    const { pipeline } = setupReadPipeline(docs)

    await expect(pipeline.findMany({ name: 'a' }, { withoutScopes: 'tenant' as never })).rejects.toBeInstanceOf(ValidationError)
  })
})

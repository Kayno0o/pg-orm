import type { InferCreateData, InferEntity } from '../src'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTxRepo, getTestSchema, orm, runInTransaction, setupTestDatabase, setupTestSuite, teardownTestDatabase, teardownTestSuite } from './setup'

const Application = orm.entity('test_applications', f => ({
  name: f.string(),
  type: f.string<'app' | 'service' | 'library'>(),
  environment: f.string<'dev' | 'staging' | 'prod'>().nullable(),
  status: f.string<'active' | 'inactive'>().default('active'),
})).build()

const MixedStrings = orm.entity('test_mixed_strings', f => ({
  regularString: f.string(),
  customString: f.string<'option1' | 'option2'>(),
})).build()

const ValidatedCustom = orm.entity('test_validated_custom', f => ({
  type: f.string<'short' | 'long'>().refine(
    val => val === 'short' || val === 'long',
    'Must be short or long',
  ),
})).build()

const UniqueCustom = orm.entity('test_unique_custom', f => ({
  code: f.string<'A' | 'B' | 'C'>().unique(),
})).build()

const MappedCustom = orm.entity('test_mapped_custom', f => ({
  appType: f.string<'web' | 'mobile'>().column('application_type'),
})).build()

beforeAll(async () => {
  // Register repositories before connecting to enable auto-migration
  orm.repo(Application)
  orm.repo(MixedStrings)
  orm.repo(ValidatedCustom)
  orm.repo(UniqueCustom)
  orm.repo(MappedCustom)
  await setupTestDatabase({ schema: getTestSchema() })
  setupTestSuite('custom-types')
})

afterAll(async () => {
  teardownTestSuite('custom-types')
  await teardownTestDatabase({ schema: getTestSchema() })
})

describe('Custom String Types - Runtime', () => {
  test('can create entity with custom type values', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      const app = await appRepo.create({
        name: 'My App',
        type: 'app',
        environment: 'prod',
      })

      expect(app.id).toBeGreaterThan(0)
      expect(app.name).toBe('My App')
      expect(app.type).toBe('app')
      expect(app.environment).toBe('prod')
      expect(app.status).toBe('active') // default value
    })
  })

  test('can create entity with different custom type values', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      const service = await appRepo.create({
        name: 'My Service',
        type: 'service',
        environment: 'staging',
        status: 'inactive',
      })

      expect(service.type).toBe('service')
      expect(service.environment).toBe('staging')
      expect(service.status).toBe('inactive')
    })
  })

  test('can create entity with nullable custom type as null', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      const lib = await appRepo.create({
        name: 'My Library',
        type: 'library',
        environment: null,
      })

      expect(lib.type).toBe('library')
      expect(lib.environment).toBeNull()
    })
  })

  test('can update custom type field', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      const app = await appRepo.create({
        name: 'Update Test',
        type: 'app',
      })

      const updated = await appRepo.update(app.id, {
        type: 'service',
      })

      expect(updated.type).toBe('service')
    })
  })

  test('can query by custom type field', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      await appRepo.create({
        name: 'App 1',
        type: 'app',
      })

      await appRepo.create({
        name: 'Service 1',
        type: 'service',
      })

      const apps = await appRepo.query()
        .where('type', '=', 'app')
        .execute()

      expect(apps.length).toBeGreaterThanOrEqual(1)
      expect(apps.every(a => a.type === 'app')).toBe(true)
    })
  })

  test('can use custom type in where conditions with operators', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      await appRepo.create({
        name: 'Prod App',
        type: 'app',
        environment: 'prod',
      })

      await appRepo.create({
        name: 'Dev App',
        type: 'app',
        environment: 'dev',
      })

      const prodApps = await appRepo.query()
        .where('environment', '=', 'prod')
        .execute()

      expect(prodApps.every(a => a.environment === 'prod')).toBe(true)
    })
  })

  test('can use custom type with IN operator', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      await appRepo.create({
        name: 'App 2',
        type: 'app',
      })

      await appRepo.create({
        name: 'Service 2',
        type: 'service',
      })

      await appRepo.create({
        name: 'Library 1',
        type: 'library',
      })

      const results = await appRepo.query()
        .whereIn('type', ['app', 'service'])
        .execute()

      expect(results.every(r => r.type === 'app' || r.type === 'service')).toBe(true)
      expect(results.every(r => r.type !== 'library')).toBe(true)
    })
  })

  test('type inference works correctly at runtime', async () => {
    await runInTransaction(async (tx) => {
      const appRepo = createTxRepo(Application, tx)

      const app = await appRepo.create({
        name: 'Type Test',
        type: 'app',
      })

      // Type should be inferred correctly
      type AppEntity = InferEntity<typeof Application.schema>
      const typedApp: AppEntity = app

      expect(typedApp.type).toBe('app')

      // CreateData should have correct types
      type CreateData = InferCreateData<typeof Application.schema>
      const createData: CreateData = {
        name: 'Another App',
        type: 'service', // Must be one of the literal types
      }

      const created = await appRepo.create(createData)

      expect(created.type).toBe('service')
    })
  })

  test('can combine regular and custom string fields', async () => {
    await runInTransaction(async (tx) => {
      const testRepo = createTxRepo(MixedStrings, tx)

      const record = await testRepo.create({
        regularString: 'any value here',
        customString: 'option1',
      })

      expect(record.regularString).toBe('any value here')
      expect(record.customString).toBe('option1')
    })
  })

  test('validation works with custom string types', async () => {
    await runInTransaction(async (tx) => {
      const validatedRepo = createTxRepo(ValidatedCustom, tx)

      const valid = await validatedRepo.create({
        type: 'short',
      })

      expect(valid.type).toBe('short')
    })
  })

  test('custom string types work with unique constraint', async () => {
    await runInTransaction(async (tx) => {
      const uniqueRepo = createTxRepo(UniqueCustom, tx)

      const first = await uniqueRepo.create({ code: 'A' })

      expect(first.code).toBe('A')

      // Second insert with same value should fail
      await expect(uniqueRepo.create({ code: 'A' })).rejects.toThrow()
    })
  })

  test('custom string types work with column name mapping', async () => {
    await runInTransaction(async (tx) => {
      const mappedRepo = createTxRepo(MappedCustom, tx)

      const record = await mappedRepo.create({
        appType: 'web',
      })

      expect(record.appType).toBe('web')

      // Verify it was stored in the correct column
      const fetched = await mappedRepo.find(record.id)

      expect(fetched?.appType).toBe('web')
    })
  })
})

import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { defineTable } from '../../../src/index'
import { setupWritePipeline } from './ops/_helpers'

const users = defineTable('users', t => ({
  id: t.serial().primaryKey(),
  name: t.text().notNull(),
}))

// Each key a request body could carry that is not a column: a typo, an injection attempt in the identifier, and the keys an object inherits.
const BAD_KEYS = ['nmae', 'name" = 1 --', 'constructor', '__proto__', 'toString']

function body(key: string): any {
  return JSON.parse(`{"name":"a",${JSON.stringify(key)}:1}`)
}

describe('writes refuse a key that is not a column of the table', () => {
  for (const key of BAD_KEYS) {
    it(`refuses ${JSON.stringify(key)} before any query`, async () => {
      const { exec, pipeline } = setupWritePipeline(users)

      await expect(pipeline.insertOne(body(key))).rejects.toThrow(ValidationError)
      await expect(pipeline.insertMany([{ name: 'b' }, body(key)])).rejects.toThrow(ValidationError)
      await expect(pipeline.updateMany(body(key), { id: 1 })).rejects.toThrow(ValidationError)
      await expect(pipeline.updateOne(body(key), { id: 1 })).rejects.toThrow(ValidationError)
      await expect(pipeline.updateById(body(key), { id: 1 })).rejects.toThrow(ValidationError)
      await expect(pipeline.updateManyById([{ id: 1, ...body(key) }])).rejects.toThrow(ValidationError)
      await expect(pipeline.upsertMany([body(key)], ['id'])).rejects.toThrow(ValidationError)
      await expect(pipeline.upsertOne({ name: 'a' }, ['id'], [key] as any)).rejects.toThrow(ValidationError)
      await expect(pipeline.upsertOne({ name: 'a' }, ['id'], { set: () => body(key) } as any)).rejects.toThrow(ValidationError)
      await expect(pipeline.findOrCreate(body(key), ['name'])).rejects.toThrow(ValidationError)
      expect(exec.queries).toEqual([])
    })
  }
})

import type { InferInsert, InferSelect, InferUpdate } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable, timestamps } from '../../../src/index'

const items = defineTable('value_types', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  count: t.int4(),
  data: t.jsonb<{ a: number }>(),
  kind: t.enum('value_kind', ['a', 'b'] as const),
  tags: t.array(t.text()),
})).withTrait(timestamps())

type Cols = typeof items.columns

// Every column used to infer as `any`, so rows accepted any value; these must stay compile errors.
describe('column value types', () => {
  it('are inferred from the column builders', () => {
    const row: InferSelect<Cols> = { id: 1, name: 'n', count: 1, data: { a: 1 }, kind: 'a', tags: ['t'], createdAt: new Date(), updatedAt: new Date() }

    // @ts-expect-error a text column takes no number
    const badName: InferUpdate<Cols> = { name: 1 }
    // @ts-expect-error an enum column takes only its values
    const badKind: InferUpdate<Cols> = { kind: 'c' }
    // @ts-expect-error the jsonb type argument is kept
    const badData: InferInsert<Cols> = { name: 'n', count: 1, data: { a: 'x' }, kind: 'a', tags: [] }
    // @ts-expect-error array elements keep their type
    const badTags: InferUpdate<Cols> = { tags: [1] }

    expect([items.name, row.name, badName, badKind, badData, badTags].length).toBe(6)
  })
})

const keyed = defineTable('value_keyed', t => ({
  uuid: t.uuid().primaryKey(),
  generatedUuid: t.uuid().primaryKey().defaultRaw('gen_random_uuid()'),
  name: t.text(),
}))

const folders = defineTable('value_folders', t => ({
  id: t.serial().primaryKey(),
  parentId: t.int4().nullable().references('value_folders', 'id', { onDelete: 'cascade' }),
}))

describe('primary keys on insert', () => {
  it('are required unless the column has a default', () => {
    const ok: InferInsert<typeof keyed.columns> = { uuid: crypto.randomUUID(), name: 'n' }
    // @ts-expect-error a uuid primary key with no default must be given
    const missing: InferInsert<typeof keyed.columns> = { name: 'n' }
    const serial: InferInsert<typeof folders.columns> = { parentId: null }

    expect([ok, missing, serial, keyed.name].length).toBe(4)
  })
})

describe('a self reference by table name', () => {
  it('types the table without an annotation and points the FK at it', () => {
    const row: InferSelect<typeof folders.columns> = { id: 1, parentId: null }

    expect(row.parentId).toBeNull()
    expect(folders.columns.parentId.references?.table().name).toBe('value_folders')
  })

  it('refuses a target name that is not an identifier', () => {
    expect(() => defineTable('bad_ref', t => ({ x: t.int4().references('a"; DROP', 'id') }))).toThrow()
  })
})

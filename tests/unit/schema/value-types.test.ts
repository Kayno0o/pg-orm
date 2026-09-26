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

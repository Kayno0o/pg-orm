import type { LiveTable } from '../../../src/migration/types'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { diffSchema } from '../../../src/migration/index'
import { splitOutsideTransaction } from '../../../src/migration/outside'

const events = defineTable('ev_events', t => ({
  id: t.serial().primaryKey(),
  kind: t.text().index({ concurrently: true }),
  at: t.timestamptz(),
})).withIndexes([{ columns: ['at'], name: 'ev_at_desc', desc: ['at'], concurrently: true }])

const registry = new Map([[events.name, events]])

const liveEvents: LiveTable = {
  name: 'ev_events',
  columns: [
    { name: 'id', dataType: 'integer', udtName: 'int4', isNullable: false, columnDefault: 'nextval(\'ev_events_id_seq\'::regclass)', isPrimaryKey: true, isUnique: false },
    { name: 'kind', dataType: 'text', udtName: 'text', isNullable: false, columnDefault: null, isPrimaryKey: false, isUnique: false },
    { name: 'at', dataType: 'timestamp with time zone', udtName: 'timestamptz', isNullable: false, columnDefault: null, isPrimaryKey: false, isUnique: false },
  ],
} as unknown as LiveTable

describe('concurrent indexes', () => {
  it('builds a concurrent index on an existing table outside the transaction', () => {
    const ops = diffSchema({ tables: [liveEvents], enums: [], indexes: [] }, registry).filter(o => o.type === 'create_index')

    expect(ops.map(o => [o.sql, o.outsideTransaction])).toEqual([
      ['CREATE INDEX CONCURRENTLY IF NOT EXISTS "ev_events_kind_idx" ON "ev_events" USING btree ("kind")', true],
      ['CREATE INDEX CONCURRENTLY IF NOT EXISTS "ev_at_desc" ON "ev_events" USING btree ("at" DESC)', true],
    ])
  })

  it('builds it in the transaction on a table the migration creates', () => {
    const ops = diffSchema({ tables: [], enums: [], indexes: [] }, registry).filter(o => o.type === 'create_index')

    expect(ops.every(o => !o.outsideTransaction && !o.sql.includes('CONCURRENTLY'))).toBe(true)
  })

  it('drops and rebuilds an index a failed build left invalid', () => {
    const live = { name: 'ev_events_kind_idx', tableName: 'ev_events', columns: ['kind'], isUnique: false, method: 'btree', definition: 'CREATE INDEX ev_events_kind_idx ON public.ev_events USING btree (kind)' }
    const valid = diffSchema({ tables: [liveEvents], enums: [], indexes: [{ ...live, isValid: true }] }, registry).filter(o => o.sql.includes('ev_events_kind_idx'))
    const invalid = diffSchema({ tables: [liveEvents], enums: [], indexes: [{ ...live, isValid: false }] }, registry).filter(o => o.sql.includes('ev_events_kind_idx'))

    expect(valid).toEqual([])
    expect(invalid.map(o => o.sql)).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "ev_events_kind_idx"',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ev_events_kind_idx" ON "ev_events" USING btree ("kind")',
    ])
  })

  it('splits the statements a transaction refuses out of migration SQL', () => {
    const sql = '-- Add column\nALTER TABLE "t" ADD COLUMN "x" int;\n\n-- Create index\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" USING btree ("x");\n\n-- Drop index\nDROP INDEX CONCURRENTLY IF EXISTS "j";\nCREATE INDEX "k" ON "t" USING btree ("x");'
    const { inside, outside } = splitOutsideTransaction(sql)

    expect(outside).toEqual(['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i" ON "t" USING btree ("x")', 'DROP INDEX CONCURRENTLY IF EXISTS "j"'])
    expect(inside).toContain('ALTER TABLE "t" ADD COLUMN "x" int;')
    expect(inside).toContain('CREATE INDEX "k"')
    expect(inside).not.toContain('CONCURRENTLY')
  })
})

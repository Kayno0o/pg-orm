import type { AnyColumnDef } from '../../../src/types/index'
import { describe, expect, it } from 'bun:test'
import { defineTable } from '../../../src/index'
import { columnChecks } from '../../../src/migration/checks'
import { generateColumnDDL } from '../../../src/migration/ddl'

describe('columnChecks', () => {
  const table = defineTable('t', c => ({ qty: c.int4().min(0).check('qty % 2 = 0'), other: c.int4().min(0) }))
  const qty = table.columns.qty as AnyColumnDef

  it('names each check after its expression, the same way every time', () => {
    const checks = columnChecks('t', 'qty', qty)

    expect(checks.map(c => c.expr)).toEqual(['qty % 2 = 0', '"qty" >= 0'])
    expect(checks.every(c => (/^t_qty_check_[0-9a-f]{8}$/).test(c.name))).toBe(true)
    expect(columnChecks('t', 'qty', qty)).toEqual(checks)
    expect(columnChecks('t', 'other', table.columns.other as AnyColumnDef)[0]!.name).not.toBe(checks[1]!.name)
  })

  it('keeps a long name within the 63 bytes PG allows', () => {
    const [check] = columnChecks('a'.repeat(60), 'qty', qty)

    expect(check!.name).toHaveLength(63)
    expect(check!.name).toMatch(/_check_[0-9a-f]{8}$/)
  })

  it('names the checks in a column DDL only when given the table', () => {
    expect(generateColumnDDL('qty', qty, 't')).toContain(`CONSTRAINT "${columnChecks('t', 'qty', qty)[0]!.name}" CHECK (qty % 2 = 0)`)
    expect(generateColumnDDL('qty', qty)).not.toContain('CONSTRAINT')
  })
})

import { describe, expect, it } from 'bun:test'
import { createColumnTypes } from '../../../src/schema/columns'

describe('ColumnBuilder', () => {
  const t = createColumnTypes()

  it('creates a text column', () => {
    const col = t.text()._build()

    expect(col._kind).toBe('column')
    expect(col.pgType).toBe('text')
    expect(col.constraints).toEqual([])
  })

  it('creates a serial column with correct phantom types', () => {
    const col = t.serial()._build()

    expect(col.pgType).toBe('serial')
  })

  it('chains notNull', () => {
    const col = t.text().notNull()._build()

    expect(col.constraints).toContainEqual({ type: 'not_null' })
  })

  it('chains nullable (removes not_null)', () => {
    const col = t.text().notNull().nullable()._build()

    expect(col.constraints.some(c => c.type === 'not_null')).toBe(false)
  })

  it('chains default', () => {
    const col = t.text().default('\'hello\'')._build()

    expect(col.constraints).toContainEqual({ type: 'default', value: '\'hello\'' })
  })

  it('chains primaryKey', () => {
    const col = t.int4().primaryKey()._build()

    expect(col.constraints).toContainEqual({ type: 'primary_key' })
  })

  it('chains unique', () => {
    const col = t.text().unique()._build()

    expect(col.constraints).toContainEqual({ type: 'unique' })
  })

  it('chains check', () => {
    const col = t.int4().check('value > 0')._build()

    expect(col.constraints).toContainEqual({ type: 'check', value: 'value > 0' })
  })

  it('chains generated', () => {
    const col = t.text().generated('first_name || \' \' || last_name')._build()

    expect(col.constraints).toContainEqual({ type: 'generated', value: 'first_name || \' \' || last_name' })
  })

  it('freezes the column def', () => {
    const col = t.text()._build()

    expect(Object.isFrozen(col)).toBe(true)
  })
})

describe('ColumnTypes factory', () => {
  const t = createColumnTypes()

  it('creates uuid', () => {
    expect(t.uuid()._build().pgType).toBe('uuid')
  })

  it('creates varchar with length', () => {
    expect(t.varchar(255)._build().pgType).toBe('varchar(255)')
  })

  it('creates int types', () => {
    expect(t.int2()._build().pgType).toBe('int2')
    expect(t.int4()._build().pgType).toBe('int4')
    expect(t.int8()._build().pgType).toBe('int8')
    expect(t.smallint()._build().pgType).toBe('int2')
    expect(t.integer()._build().pgType).toBe('int4')
    expect(t.bigint()._build().pgType).toBe('int8')
  })

  it('creates float types', () => {
    expect(t.float4()._build().pgType).toBe('float4')
    expect(t.float8()._build().pgType).toBe('float8')
    expect(t.real()._build().pgType).toBe('float4')
    expect(t.doublePrecision()._build().pgType).toBe('float8')
  })

  it('creates numeric with precision', () => {
    expect(t.numeric()._build().pgType).toBe('numeric')
    expect(t.numeric(10)._build().pgType).toBe('numeric(10)')
    expect(t.numeric(10, 2)._build().pgType).toBe('numeric(10,2)')
  })

  it('creates boolean', () => {
    expect(t.bool()._build().pgType).toBe('bool')
    expect(t.boolean()._build().pgType).toBe('bool')
  })

  it('creates date/time types', () => {
    expect(t.date()._build().pgType).toBe('date')
    expect(t.timestamp()._build().pgType).toBe('timestamp')
    expect(t.timestamptz()._build().pgType).toBe('timestamptz')
    expect(t.interval()._build().pgType).toBe('interval')
    expect(t.time()._build().pgType).toBe('time')
    expect(t.timetz()._build().pgType).toBe('timetz')
  })

  it('creates json/jsonb', () => {
    expect(t.json()._build().pgType).toBe('json')
    expect(t.jsonb()._build().pgType).toBe('jsonb')
  })

  it('creates bytea', () => {
    expect(t.bytea()._build().pgType).toBe('bytea')
  })

  it('creates enum', () => {
    const col = t.enum('status', ['active', 'inactive'] as const)
    const built = col._build()

    expect(built.pgType).toBe('status')
  })

  it('creates array', () => {
    const col = t.array(t.text())._build()

    expect(col.pgType).toBe('text[]')
  })

  it('creates vector', () => {
    expect(t.vector(384)._build().pgType).toBe('vector(384)')
  })

  it('creates inet', () => {
    expect(t.inet()._build().pgType).toBe('inet')
  })

  it('creates tsvector', () => {
    expect(t.tsvector()._build().pgType).toBe('tsvector')
  })
})

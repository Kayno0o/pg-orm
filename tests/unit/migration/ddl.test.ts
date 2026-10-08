import type { AnyColumnDef, AnyTableDef } from '../../../src/types/index'
import { describe, expect, test } from 'bun:test'
import { defineTable } from '../../../src/index'
import { generateColumnDDL, generateCreateTable, normalizeDefault, normalizeType, sameDefault } from '../../../src/migration/ddl'

function colOf(table: AnyTableDef, name: string) {
  return generateColumnDDL(name, table.columns[name] as AnyColumnDef)
}

describe('generateCreateTable', () => {
  test('emits CREATE TABLE with quoted name and column list', () => {
    const t = defineTable('users', c => ({
      id: c.serial().primaryKey(),
      name: c.text().notNull(),
    }))
    const sql = generateCreateTable('users', t)

    expect(sql).toContain('CREATE TABLE "users"')
    expect(sql).toContain('"id" serial')
    expect(sql).toContain('"name" text NOT NULL')
    expect(sql).toContain('PRIMARY KEY ("id")')
  })

  test('emits all major column types', () => {
    const t = defineTable('types_demo', c => ({
      pk: c.uuid().primaryKey(),
      txt: c.text(),
      vc: c.varchar(50),
      i2: c.int2(),
      i4: c.int4(),
      i8: c.int8(),
      flt: c.float8(),
      num: c.numeric(10, 2),
      b: c.bool(),
      d: c.date(),
      ts: c.timestamp(),
      tstz: c.timestamptz(),
      j: c.json(),
      jb: c.jsonb(),
      bin: c.bytea(),
    }))
    const sql = generateCreateTable('types_demo', t)

    expect(sql).toContain('"pk" uuid')
    expect(sql).toContain('"txt" text')
    expect(sql).toContain('"vc" varchar(50)')
    expect(sql).toContain('"i2" int2')
    expect(sql).toContain('"i4" int4')
    expect(sql).toContain('"i8" int8')
    expect(sql).toContain('"flt" float8')
    expect(sql).toContain('"num" numeric(10,2)')
    expect(sql).toContain('"b" bool')
    expect(sql).toContain('"d" date')
    expect(sql).toContain('"ts" timestamp')
    expect(sql).toContain('"tstz" timestamptz')
    expect(sql).toContain('"j" json')
    expect(sql).toContain('"jb" jsonb')
    expect(sql).toContain('"bin" bytea')
  })

  test('reserved keyword column names are safely double-quoted', () => {
    const t = defineTable('keyword_cols', c => ({
      id: c.serial().primaryKey(),
      order: c.int4(),
      user: c.text(),
      select: c.text(),
    }))
    const sql = generateCreateTable('keyword_cols', t)

    expect(sql).toContain('"order" int4')
    expect(sql).toContain('"user" text')
    expect(sql).toContain('"select" text')
  })

  test('composite PK emits multi-column PRIMARY KEY clause', () => {
    const t = defineTable('membership', c => ({
      user_id: c.int4().primaryKey(),
      group_id: c.int4().primaryKey(),
    }))
    const sql = generateCreateTable('membership', t)

    expect(sql).toContain('PRIMARY KEY ("user_id", "group_id")')
  })

  test('table with no PK emits no PRIMARY KEY clause', () => {
    const t = defineTable('audit', c => ({
      payload: c.text(),
    }))
    const sql = generateCreateTable('audit', t)

    expect(sql).not.toContain('PRIMARY KEY')
  })

  test('UNIQUE column emits table-level UNIQUE constraint', () => {
    const t = defineTable('users', c => ({
      id: c.serial().primaryKey(),
      email: c.text().notNull().unique(),
    }))
    const sql = generateCreateTable('users', t)

    expect(sql).toContain('UNIQUE ("email")')
  })
})

describe('generateColumnDDL — defaults', () => {
  test('NOT NULL constraint', () => {
    const t = defineTable('t', c => ({
      x: c.text().notNull(),
    }))

    expect(colOf(t, 'x')).toBe('"x" text NOT NULL')
  })

  test('DEFAULT with simple literal', () => {
    const t = defineTable('t', c => ({
      x: c.int4().default(42),
    }))

    expect(colOf(t, 'x')).toBe('"x" int4 NOT NULL DEFAULT 42')
  })

  test('DEFAULT with string literal containing single quotes is escaped', () => {
    const t = defineTable('t', c => ({
      x: c.text().default('it\'s ok'),
    }))

    const ddl = colOf(t, 'x')

    expect(ddl).toContain('DEFAULT \'it\'\'s ok\'')
  })

  test('defaultRaw embeds expression verbatim', () => {
    const t = defineTable('t', c => ({
      x: c.timestamptz().defaultRaw('NOW()'),
    }))

    expect(colOf(t, 'x')).toBe('"x" timestamptz NOT NULL DEFAULT NOW()')
  })
})

describe('generateColumnDDL — generated and check', () => {
  test('generated column emits GENERATED ALWAYS AS ... STORED', () => {
    const t = defineTable('t', c => ({
      first: c.text().notNull(),
      last: c.text().notNull(),
      full: c.text().generated('first || \' \' || last'),
    }))

    const ddl = colOf(t, 'full')

    expect(ddl).toContain('GENERATED ALWAYS AS (first || \' \' || last) STORED')
  })

  test('check() constraint emits inline CHECK clause', () => {
    const t = defineTable('t', c => ({
      age: c.int4().check('age >= 0'),
    }))

    expect(colOf(t, 'age')).toContain('CHECK (age >= 0)')
  })

  test('min()/max() emit numeric CHECK referencing column name', () => {
    const t = defineTable('t', c => ({
      qty: c.int4().min(1).max(100),
    }))

    const ddl = colOf(t, 'qty')

    expect(ddl).toContain('CHECK ("qty" >= 1 AND "qty" <= 100)')
  })

  test('minLength()/maxLength() emit length CHECKs', () => {
    const t = defineTable('t', c => ({
      name: c.text().minLength(2).maxLength(50),
    }))

    expect(colOf(t, 'name')).toContain('CHECK (length("name") >= 2 AND length("name") <= 50)')
  })

  test('pattern() emits regex match CHECK with escaped literal', () => {
    const t = defineTable('t', c => ({
      slug: c.text().pattern('^[a-z\'-]+$'),
    }))

    const ddl = colOf(t, 'slug')

    expect(ddl).toContain('CHECK ("slug" ~ \'^[a-z\'\'-]+$\')')
  })

  test('oneOf() emits IN clause with quoted string members', () => {
    const t = defineTable('t', c => ({
      role: c.text().oneOf(['admin', 'user']),
    }))

    expect(colOf(t, 'role')).toContain('CHECK ("role" IN (\'admin\', \'user\'))')
  })

  test('reserved keyword column name flows through inline CHECK quoted', () => {
    const t = defineTable('t', c => ({
      order: c.int4().min(0),
    }))

    expect(colOf(t, 'order')).toContain('CHECK ("order" >= 0)')
  })
})

describe('normalizeType', () => {
  test('serial → integer', () => {
    expect(normalizeType('serial')).toBe('integer')
  })

  test('bigserial → bigint', () => {
    expect(normalizeType('bigserial')).toBe('bigint')
  })

  test('int4 → integer; int2 → smallint; int8 → bigint', () => {
    expect(normalizeType('int4')).toBe('integer')
    expect(normalizeType('int2')).toBe('smallint')
    expect(normalizeType('int8')).toBe('bigint')
  })

  test('float4 → real; float8 → double precision', () => {
    expect(normalizeType('float4')).toBe('real')
    expect(normalizeType('float8')).toBe('double precision')
  })

  test('bool → boolean', () => {
    expect(normalizeType('bool')).toBe('boolean')
  })

  test('timestamptz → timestamp with time zone', () => {
    expect(normalizeType('timestamptz')).toBe('timestamp with time zone')
  })

  test('timetz → time with time zone', () => {
    expect(normalizeType('timetz')).toBe('time with time zone')
  })

  test('uppercase input is lowercased', () => {
    expect(normalizeType('SERIAL')).toBe('integer')
  })

  test('schema types match the spelling format_type() prints', () => {
    const cases: [string, string][] = [
      ['char(5)', 'character(5)'],
      ['bpchar', 'character(1)'],
      ['varchar(10)[]', 'character varying(10)[]'],
      ['varchar(10)[][]', 'character varying(10)[]'],
      ['numeric(10)', 'numeric(10,0)'],
      ['numeric(10, 2)', 'numeric(10,2)'],
      ['bit', 'bit(1)'],
      ['varbit(8)', 'bit varying(8)'],
      ['timestamp', 'timestamp without time zone'],
      ['vector(3)', 'vector(3)'],
    ]

    for (const [schema, live] of cases)
      expect(normalizeType(schema)).toBe(normalizeType(live))
  })

  test('a schema-qualified or quoted live type matches its bare name', () => {
    expect(normalizeType('public.vector(3)')).toBe('vector(3)')
    expect(normalizeType('"Status"')).toBe('status')
  })

  test('a type of another length stays different', () => {
    expect(normalizeType('vector(3)')).not.toBe(normalizeType('vector(4)'))
    expect(normalizeType('char(5)')).not.toBe(normalizeType('character(6)'))
  })
})

describe('normalizeDefault', () => {
  test('strips trailing cast', () => {
    expect(normalizeDefault('\'user\'::text')).toBe('\'user\'')
  })

  test('a numeric default given as a string matches its unquoted live form', () => {
    expect(normalizeDefault('\'0.00\'')).toBe(normalizeDefault('0.00'))
    expect(normalizeDefault('\'-1.5\'')).toBe(normalizeDefault('\'-1.5\'::numeric'))
  })

  test('empty array default matches its live form', () => {
    expect(normalizeDefault('ARRAY[]::text[]')).toBe(normalizeDefault('ARRAY[]::text[]'))
  })

  test('non-empty array default matches its per-element-cast live form', () => {
    // toSQLDefault emits ARRAY['user']::text[]; Postgres introspects it back
    // with per-element casts, so the two must normalize equal to avoid a
    // perpetual SET DEFAULT diff.
    expect(normalizeDefault('ARRAY[\'user\']::text[]'))
      .toBe(normalizeDefault('ARRAY[\'user\'::text]'))
  })

  test('multi-element array default matches its live form', () => {
    expect(normalizeDefault('ARRAY[\'a\',\'b\']::text[]'))
      .toBe(normalizeDefault('ARRAY[\'a\'::text, \'b\'::text]'))
  })

  test('keeps the case of a quoted literal', () => {
    expect(normalizeDefault('\'User\'::text')).not.toBe(normalizeDefault('\'user\'::text'))
  })
})

describe('sameDefault', () => {
  // The right-hand values are what Postgres 18 prints back through pg_get_expr for each schema default.
  test('a Date default matches its live timestamp', () => {
    expect(sameDefault('\'2024-01-01T10:00:00.000Z\'', '\'2024-01-01 10:00:00+00\'::timestamp with time zone', 'timestamptz')).toBe(true)
    expect(sameDefault('\'2024-01-01T10:00:00.000Z\'', '\'2024-01-01 11:00:00+01\'::timestamp with time zone', 'timestamptz')).toBe(true)
    expect(sameDefault('\'2024-01-01T10:00:00.000Z\'', '\'2024-01-01 10:00:00\'::timestamp without time zone', 'timestamp')).toBe(true)
    expect(sameDefault('\'2024-01-01T00:00:00.000Z\'', '\'2024-01-01\'::date', 'date')).toBe(true)
  })

  test('another instant stays different', () => {
    expect(sameDefault('\'2024-01-01T10:00:00.000Z\'', '\'2024-01-01 10:00:01+00\'::timestamp with time zone', 'timestamptz')).toBe(false)
  })

  test('an empty array matches every live spelling of one', () => {
    expect(sameDefault('ARRAY[]::text[]', '\'{}\'::text[]', 'text[]')).toBe(true)
    expect(sameDefault('ARRAY[]::varchar(10)[]', '(ARRAY[]::character varying[])::character varying(10)[]', 'varchar(10)[]')).toBe(true)
  })

  test('a jsonb default matches whatever key order Postgres prints', () => {
    expect(sameDefault('\'{"bb":1,"a":{"y":2,"x":1}}\'::jsonb', '\'{"a": {"x": 1, "y": 2}, "bb": 1}\'::jsonb', 'jsonb')).toBe(true)
    expect(sameDefault('\'{"a":1}\'::jsonb', '\'{"a": 2}\'::jsonb', 'jsonb')).toBe(false)
  })

  test('a number matches however many trailing zeros Postgres keeps', () => {
    expect(sameDefault('1.5', '1.50', 'numeric(5,2)')).toBe(true)
  })

  test('a char default matches its bpchar cast', () => {
    expect(sameDefault('\'ab\'', '\'ab\'::bpchar', 'char(3)')).toBe(true)
  })
})

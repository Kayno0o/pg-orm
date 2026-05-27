import type { AnyColumnDef, AnyTableDef } from '../../../src/types/index'
import { describe, expect, test } from 'bun:test'
import { defineTable } from '../../../src/index'
import { generateColumnDDL, generateCreateTable, generateReverseOp, normalizeType } from '../../../src/migration/ddl'

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

    expect(colOf(t, 'x')).toBe('"x" int4 DEFAULT 42')
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

    expect(colOf(t, 'x')).toBe('"x" timestamptz DEFAULT NOW()')
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
})

describe('generateReverseOp', () => {
  test('reverses create_table with DROP TABLE IF EXISTS', () => {
    expect(generateReverseOp({
      type: 'create_table',
      table: 'users',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('DROP TABLE IF EXISTS "users";')
  })

  test('drop_table reverse is a comment (irreversible)', () => {
    const rev = generateReverseOp({
      type: 'drop_table',
      table: 'users',
      sql: '',
      destructive: true,
      description: '',
    })

    expect(rev.startsWith('--')).toBe(true)
    expect(rev).toContain('Cannot reverse')
  })

  test('add_column reverses to DROP COLUMN IF EXISTS', () => {
    expect(generateReverseOp({
      type: 'add_column',
      table: 'users',
      column: 'email',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('ALTER TABLE "users" DROP COLUMN IF EXISTS "email";')
  })

  test('drop_column reverse is a comment (cannot recover original type)', () => {
    const rev = generateReverseOp({
      type: 'drop_column',
      table: 'users',
      column: 'email',
      sql: '',
      destructive: true,
      description: '',
    })

    expect(rev.startsWith('--')).toBe(true)
  })

  test('create_index reverses to DROP INDEX IF EXISTS with extracted name', () => {
    expect(generateReverseOp({
      type: 'create_index',
      sql: 'CREATE INDEX "users_email_idx" ON "users" ("email")',
      destructive: false,
      description: '',
    })).toBe('DROP INDEX IF EXISTS "users_email_idx";')
  })

  test('add_fk reverses to DROP CONSTRAINT with conventional name', () => {
    expect(generateReverseOp({
      type: 'add_fk',
      table: 'posts',
      column: 'user_id',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_user_id_fkey";')
  })

  test('rename_column reverses to swap directions', () => {
    const rev = generateReverseOp({
      type: 'rename_column',
      table: 'users',
      sql: 'ALTER TABLE "users" RENAME COLUMN "old" TO "new"',
      destructive: false,
      description: '',
    })

    expect(rev).toBe('ALTER TABLE "users" RENAME COLUMN "new" TO "old";')
  })

  test('unknown op type returns a comment', () => {
    const rev = generateReverseOp({
      type: 'alter_column',
      table: 'users',
      sql: '',
      destructive: false,
      description: 'set NOT NULL',
    })

    expect(rev.startsWith('--')).toBe(true)
    expect(rev).toContain('set NOT NULL')
  })
})

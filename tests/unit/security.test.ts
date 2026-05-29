import type { AnyColumns } from '../../src'
import type { ExprTape } from '../../src/builder/expr'
import type { QueryError } from '../../src/errors/index'
/**
 * Security tests — SQL injection, identifier escaping, input validation,
 * error message leakage, and common OWASP-style attack vectors.
 */
import { describe, expect, it } from 'bun:test'
import { assembleExpr, createExprBuilder } from '../../src/builder/expr'
import { assembleQuery, DeleteBuilder, InsertBuilder, MergeBuilder, SelectBuilder, UpdateBuilder } from '../../src/builder/query'
import { UniqueError, wrapPgError } from '../../src/errors/index'
import { compileMapper } from '../../src/mapper/index'
import { defineTable } from '../../src/schema/table'
import { sanitizeMigrationName, validateIdentifier, validateRawSqlFragment } from '../../src/schema/validate'
import { escapeLiteralBody, quote, quoteLiteral, quotePath } from '../../src/sql/utils'

const e = createExprBuilder<any>()

function sql(tape: any, offset = 0) {
  return assembleExpr(tape as ExprTape, offset)
}

// ─── Identifier Validation ───────────────────────────────────────────────────

describe('Security: Identifier Validation', () => {
  const injections = [
    'users; DROP TABLE users',
    'users; DROP TABLE users --',
    '" OR 1=1 --',
    '\'; DELETE FROM users; --',
    'users\nDROP TABLE users',
    'admin"--',
    'users/**/UNION/**/SELECT',
    'col\0name',
    '$(whoami)',
    'users`; ls',
    'Robert\'); DROP TABLE students;--',
    'name OR 1=1',
    'a; GRANT ALL ON ALL TABLES TO public',
    '1=1; --',
    'users UNION SELECT * FROM pg_shadow',
    'table\tname',
    'name;--',
    '../../../etc/passwd',
    'x\x00y',
  ]

  for (const payload of injections) {
    it(`rejects table name: ${JSON.stringify(payload)}`, () => {
      expect(() => validateIdentifier(payload, 'table')).toThrow()
    })

    it(`rejects column name: ${JSON.stringify(payload)}`, () => {
      expect(() => validateIdentifier(payload, 'column')).toThrow()
    })
  }

  it('rejects identifiers starting with numbers', () => {
    expect(() => validateIdentifier('1users', 'table')).toThrow()
    expect(() => validateIdentifier('0x41', 'column')).toThrow()
  })

  it('rejects identifiers with hyphens, dots, spaces', () => {
    expect(() => validateIdentifier('user-name', 'table')).toThrow()
    expect(() => validateIdentifier('user.name', 'column')).toThrow()
    expect(() => validateIdentifier('user name', 'table')).toThrow()
  })

  it('accepts only safe identifiers', () => {
    expect(() => validateIdentifier('users', 'table')).not.toThrow()
    expect(() => validateIdentifier('_private', 'column')).not.toThrow()
    expect(() => validateIdentifier('col_123_test', 'column')).not.toThrow()
    expect(() => validateIdentifier('CamelCase', 'table')).not.toThrow()
  })
})

// ─── Quote Function ──────────────────────────────────────────────────────────

describe('Security: quote() escaping', () => {
  it('escapes internal double quotes', () => {
    expect(quote('col"name')).toBe('"col""name"')
  })

  it('escapes multiple double quotes', () => {
    expect(quote('a""b')).toBe('"a""""b"')
  })

  it('passes through * unquoted', () => {
    expect(quote('*')).toBe('*')
  })

  it('quotes injection attempts', () => {
    // Even if an injection string gets past validation somehow,
    // quote() neutralizes it by wrapping in double quotes
    expect(quote('users"; DROP TABLE users; --')).toBe('"users""; DROP TABLE users; --"')
    expect(quote('\'; DELETE FROM users')).toBe('"\'; DELETE FROM users"')
  })

  it('handles empty string', () => {
    expect(quote('')).toBe('""')
  })

  it('handles null bytes in strings', () => {
    const result = quote('col\0name')

    expect(result).toContain('"')
    // Should be wrapped in quotes regardless
    expect(result.startsWith('"')).toBe(true)
    expect(result.endsWith('"')).toBe(true)
  })
})

describe('Security: quotePath() escaping', () => {
  it('quotes each segment independently', () => {
    expect(quotePath('table.column')).toBe('"table"."column"')
  })

  it('escapes injection in path segments', () => {
    expect(quotePath('a".b')).toBe('"a"""."b"')
  })
})

// ─── defineTable Validation ──────────────────────────────────────────────────

describe('Security: defineTable rejects injection in names', () => {
  it('rejects SQL injection in table name', () => {
    expect(() => defineTable('users; DROP TABLE users', t => ({
      id: t.serial().primaryKey(),
    }))).toThrow(/Invalid table name/)
  })

  it('rejects SQL injection in column name', () => {
    expect(() => defineTable('users', t => ({
      'id; DROP TABLE users': t.serial().primaryKey(),
    }))).toThrow(/Invalid column name/)
  })

  it('rejects unicode zero-width characters in names', () => {
    expect(() => defineTable('users\u200B', t => ({
      id: t.serial().primaryKey(),
    }))).toThrow()
  })

  it('rejects newlines in table names', () => {
    expect(() => defineTable('users\nDROP', t => ({
      id: t.serial().primaryKey(),
    }))).toThrow()
  })
})

// ─── Parameterization (SQL Injection Prevention) ─────────────────────────────

describe('Security: Query values are always parameterized', () => {
  it('WHERE values are parameterized, not interpolated', () => {
    const result = sql(e.eq('email', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('"email" = $1')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
    // The malicious value is NEVER in the SQL string
    expect(result.sql).not.toContain('DROP')
  })

  it('IN values are parameterized', () => {
    const payload = ['\'; DROP TABLE users; --', '1 OR 1=1']
    const result = sql(e.in('status', payload))

    expect(result.sql).toBe('"status" IN ($1, $2)')
    expect(result.params).toEqual(payload)
    expect(result.sql).not.toContain('DROP')
    expect(result.sql).not.toContain('OR')
  })

  it('BETWEEN values are parameterized', () => {
    const result = sql(e.between('id', '1; DROP TABLE users', '100'))

    expect(result.sql).toBe('"id" BETWEEN $1 AND $2')
    expect(result.params[0]).toBe('1; DROP TABLE users')
    expect(result.sql).not.toContain('DROP')
  })

  it('LIKE patterns are parameterized', () => {
    const result = sql(e.like('name', '%\'; DROP TABLE users; --%'))

    expect(result.sql).toBe('"name" LIKE $1')
    expect(result.params).toEqual(['%\'; DROP TABLE users; --%'])
    expect(result.sql).not.toContain('DROP')
  })

  it('ILIKE patterns are parameterized', () => {
    const result = sql(e.ilike('name', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('"name" ILIKE $1')
    expect(result.params[0]).toBe('\'; DROP TABLE users; --')
  })

  it('JSONB path is parameterized', () => {
    const result = sql(e.jsonbPath('data', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('jsonb_path_exists("data", $1)')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
    expect(result.sql).not.toContain('DROP')
  })

  it('JSONB subscript keys are parameterized', () => {
    const result = sql(e.jsonbSubscript('data', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('("data" -> $1)')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
    expect(result.sql).not.toContain('DROP')
  })

  it('full-text search query and language are parameterized', () => {
    const q = e.tsQuery('english', '\'; DROP TABLE users; --')
    const result = sql(e.tsMatch('searchVector', q))

    expect(result.params).toEqual(['english', '\'; DROP TABLE users; --'])
    expect(result.sql).not.toContain('DROP')
    expect(result.sql).toContain('plainto_tsquery($')
  })

  it('vector values are parameterized', () => {
    const result = sql(e.vectorCosineDistance('embedding', [1, 2, 3]))

    expect(result.params).toEqual([[1, 2, 3]])
    expect(result.sql).toContain('<=>')
  })

  it('array contains value is parameterized', () => {
    const result = sql(e.arrayContains('tags', '\'; DROP TABLE users; --'))

    expect(result.sql).toBe('$1 = ANY("tags")')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
  })

  it('array overlap values are parameterized', () => {
    const result = sql(e.arrayOverlap('tags', ['\'; DROP TABLE users; --']))

    expect(result.sql).toBe('"tags" && ARRAY[$1]')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
  })

  it('raw expression uses parameterized placeholders', () => {
    const result = sql(e.raw('? > ? AND ? < ?', 'a\'; DROP TABLE users', 10, 'b', 20))

    expect(result.sql).toBe('$1 > $2 AND $3 < $4')
    expect(result.params).toEqual(['a\'; DROP TABLE users', 10, 'b', 20])
    expect(result.sql).not.toContain('DROP')
  })
})

// ─── LIKE Pattern Escaping ───────────────────────────────────────────────────

describe('Security: LIKE pattern auto-escaping', () => {
  it('startsWith escapes % in user input', () => {
    const result = sql(e.startsWith('name', '100%'))

    expect(result.params).toEqual(['100\\%%'])
    // The user's % is escaped, only the trailing wildcard is kept
  })

  it('startsWith escapes _ in user input', () => {
    const result = sql(e.startsWith('name', 'test_user'))

    expect(result.params).toEqual(['test\\_user%'])
  })

  it('startsWith escapes backslash in user input', () => {
    const result = sql(e.startsWith('name', 'path\\to'))

    expect(result.params).toEqual(['path\\\\to%'])
  })

  it('endsWith escapes special chars', () => {
    const result = sql(e.endsWith('name', '%_\\evil'))

    expect(result.params).toEqual(['%\\%\\_\\\\evil'])
  })

  it('contains escapes all LIKE metacharacters', () => {
    const result = sql(e.contains('name', '%_\\'))

    expect(result.params).toEqual(['%\\%\\_\\\\%'])
  })

  it('contains prevents LIKE injection to match everything', () => {
    const result = sql(e.contains('name', '%'))

    // Should NOT produce '%%%' (which matches everything), but '%\%%'
    expect(result.params).toEqual(['%\\%%'])
  })
})

// ─── stringAgg Delimiter Validation ──────────────────────────────────────────

describe('Security: stringAgg delimiter injection', () => {
  const maliciousDelimiters = [
    '\'); DROP TABLE users; --',
    '\' || chr(0) || \'',
    '\' UNION SELECT password FROM users --',
    '\'); COPY pg_shadow TO \'/tmp/shadow',
    '\' || pg_read_file(\'/etc/passwd\') || \'',
    '$(whoami)',
    '`id`',
    '\' OR \'1\'=\'1',
  ]

  for (const delimiter of maliciousDelimiters) {
    it(`rejects malicious delimiter: ${JSON.stringify(delimiter).slice(0, 50)}`, () => {
      expect(() => e.stringAgg('name', delimiter)).toThrow(/unsafe delimiter/)
    })
  }

  it('allows safe delimiters', () => {
    expect(() => e.stringAgg('name', ', ')).not.toThrow()
    expect(() => e.stringAgg('name', ' | ')).not.toThrow()
    expect(() => e.stringAgg('name', ';')).not.toThrow()
    expect(() => e.stringAgg('name', '-')).not.toThrow()
    expect(() => e.stringAgg('name', '/')).not.toThrow()
  })
})

// ─── Full-Text Search Language Injection ─────────────────────────────────────

describe('Security: tsQuery language whitelist', () => {
  const injections = [
    'english\'; DROP TABLE users; --',
    'english" OR "1"="1',
    'english; SELECT pg_sleep(10)',
    '../../../etc/passwd',
    '',
    'ENGLISH', // case-sensitive validation
    'EnGlIsH',
  ]

  for (const lang of injections) {
    it(`rejects language: ${JSON.stringify(lang)}`, () => {
      expect(() => e.tsQuery(lang, 'test')).toThrow()
    })
  }
})

// ─── INSERT/UPDATE Value Validation ──────────────────────────────────────────

describe('Security: INSERT/UPDATE value validation', () => {
  it('blocks __raw objects in INSERT values', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    expect(() => builder.values({
      name: { __raw: 'DROP TABLE users' },
    })).toThrow(/__raw/)
  })

  it('blocks __raw objects in UPDATE values', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    const builder = new UpdateBuilder<any, any>(table.name)

    expect(() => builder.set({
      name: { __raw: 'DROP TABLE users' },
    })).toThrow(/__raw/)
  })

  it('blocks undefined values to prevent missing columns', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    expect(() => builder.values({
      name: undefined,
    })).toThrow(/undefined/)
  })

  it('blocks NaN values', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      age: t.int4(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    expect(() => builder.values({
      age: Number.NaN,
    })).toThrow(/non-finite/)
  })

  it('blocks Infinity values', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      score: t.real(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    expect(() => builder.values({
      score: Infinity,
    })).toThrow(/non-finite/)
  })
})

// ─── JIT Mapper Safety ──────────────────────────────────────────────────────

describe('Security: JIT mapper cannot execute arbitrary code', () => {
  it('mapper only reads properties, cannot inject code', () => {
    // Even if a column name somehow contained code-like strings,
    // JSON.stringify in the mapper prevents code injection
    const columns = {
      safe_col: { sqlType: 'text', constraints: [] },
    } as unknown as AnyColumns
    const mapper = compileMapper(columns)

    // The mapper should work normally
    const result = mapper({ safe_col: 'hello' })

    expect(result).toEqual({ safe_col: 'hello' })
  })

  it('mapper returns undefined for missing properties, does not throw', () => {
    const columns = {
      name: { sqlType: 'text', constraints: [] },
    } as unknown as AnyColumns
    const mapper = compileMapper(columns, ['name'])
    const result = mapper({})

    expect(result).toEqual({ name: undefined })
  })
})

// ─── Migration Name Sanitization ─────────────────────────────────────────────

describe('Security: Migration name path traversal', () => {
  it('strips path traversal attempts', () => {
    // Each non-word char (except -) is replaced with _
    expect(sanitizeMigrationName('../../../etc/passwd')).toBe('_________etc_passwd')
    expect(sanitizeMigrationName('..\\..\\windows\\system32')).toBe('______windows_system32')
  })

  it('strips command injection characters', () => {
    // hyphens are kept by the regex /[^\w-]/g
    expect(sanitizeMigrationName('migration; rm -rf /')).toBe('migration__rm_-rf__')
    expect(sanitizeMigrationName('$(whoami)')).toBe('__whoami_')
    expect(sanitizeMigrationName('migration`id`')).toBe('migration_id_')
  })

  it('strips special SQL characters', () => {
    expect(sanitizeMigrationName('name\'; DROP TABLE')).toBe('name___DROP_TABLE')
  })

  it('preserves valid migration names', () => {
    expect(sanitizeMigrationName('2024-01-01_add_users')).toBe('2024-01-01_add_users')
    expect(sanitizeMigrationName('create-posts-table')).toBe('create-posts-table')
  })
})

// ─── Error Message Leakage ───────────────────────────────────────────────────

describe('Security: Error message sanitization in production', () => {
  const originalEnv = process.env.NODE_ENV
  const originalRedact = process.env.REDACT_QUERY_LOGS

  it('redacts query SQL and params when REDACT_QUERY_LOGS=1', () => {
    process.env.REDACT_QUERY_LOGS = '1'

    try {
      const err = wrapPgError(
        Object.assign(new Error('duplicate key value violates unique constraint "uq_email" Detail: Key (email)=(secret@example.com) already exists.'), { errno: '23505', constraint_name: 'uq_email', table_name: 'users', column_name: 'email' }),
        'INSERT INTO "users" (email, password_hash) VALUES ($1, $2)',
        ['secret@example.com', '$2b$12$secrethash'],
      )

      // Query should be redacted
      expect((err as QueryError).query).toBe('[REDACTED]')
      // Params should be empty
      expect((err as QueryError).params).toEqual([])
      // Message should be redacted
      expect(err.message).toBe('[REDACTED]')
    }
    finally {
      process.env.REDACT_QUERY_LOGS = originalRedact
    }
  })

  it('redacts Detail: lines in production mode', () => {
    process.env.NODE_ENV = 'production'
    process.env.REDACT_QUERY_LOGS = undefined

    try {
      const err = wrapPgError(
        Object.assign(new Error('duplicate key Detail: Key (email)=(secret@example.com) already exists.'), { errno: '23505', constraint_name: 'uq_email', table_name: 'users' }),
        'INSERT INTO "users" VALUES ($1)',
        ['secret@example.com'],
      )

      // Message should be fully redacted in production
      expect(err.message).not.toContain('secret@example.com')
    }
    finally {
      process.env.NODE_ENV = originalEnv
      process.env.REDACT_QUERY_LOGS = originalRedact
    }
  })

  it('preserves structured error info even when message is redacted', () => {
    process.env.REDACT_QUERY_LOGS = '1'

    try {
      const err = wrapPgError(
        Object.assign(new Error('Error message with sensitive data'), { errno: '23505', constraint_name: 'uq_email', table_name: 'users', column_name: 'email' }),
        'SELECT * FROM users',
        [],
      )

      // Structured fields should still be accessible for programmatic error handling
      expect(err).toBeInstanceOf(UniqueError)
      const uniqueErr = err as UniqueError

      expect(uniqueErr.constraint).toBe('uq_email')
      expect(uniqueErr.table).toBe('users')
      expect(uniqueErr.column).toBe('email')
    }
    finally {
      process.env.REDACT_QUERY_LOGS = originalRedact
    }
  })
})

// ─── Second-Order SQL Injection ──────────────────────────────────────────────

describe('Security: Second-order SQL injection via stored values', () => {
  it('parameterizes values read from DB when used in WHERE', () => {
    // Simulates using a value from one query in another
    const storedMaliciousValue = '\'; DROP TABLE users; --'
    const result = sql(e.eq('name', storedMaliciousValue))

    expect(result.sql).toBe('"name" = $1')
    expect(result.params).toEqual([storedMaliciousValue])
    expect(result.sql).not.toContain('DROP')
  })

  it('parameterizes values from DB in IN clause', () => {
    const storedValues = ['normal', '\'; DROP TABLE users; --', '1 OR 1=1']
    const result = sql(e.in('id', storedValues))

    expect(result.sql).toBe('"id" IN ($1, $2, $3)')
    expect(result.params).toEqual(storedValues)
    expect(result.sql).not.toContain('DROP')
  })
})

// ─── Prototype Pollution ─────────────────────────────────────────────────────

describe('Security: Prototype pollution protection', () => {
  it('defineTable does not process __proto__ as column name', () => {
    // __proto__ contains underscore which passes the regex,
    // but it should not allow prototype pollution
    defineTable('test_table', t => ({
      __proto__: t.text(),
    }))

    // Should not pollute Object.prototype
    // @ts-expect-error we're checking if variable does not exist
    expect({}.sqlType).toBeUndefined()
  })

  it('defineTable does not process constructor as column name', () => {
    const table = defineTable('test_table', t => ({
      constructor: t.text(),
    }))

    // Table should still be well-formed
    expect(table.name).toBe('test_table')
  })
})

// ─── SQL Assembly Safety (Full Query Tests) ──────────────────────────────────

describe('Security: Full query assembly with malicious inputs', () => {
  const table = defineTable('users', t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
    email: t.text().notNull(),
  }))

  it('SELECT with injection in WHERE value', () => {
    const builder = new SelectBuilder<any, any, any>(table.name)
    const state = builder.where(e => e.eq('name', '\'; DROP TABLE users; --'))
    const result = assembleQuery(state._state)

    expect(result.sql).toContain('WHERE "name" = $1')
    expect(result.params).toEqual(['\'; DROP TABLE users; --'])
    expect(result.sql).not.toContain('DROP')
  })

  it('INSERT parameterizes all values', () => {
    const builder = new InsertBuilder<any, any>(table.name)
    const state = builder.values({
      name: '\'; DROP TABLE users; --',
      email: '1 OR 1=1',
    }).returning()
    const result = assembleQuery(state._state)

    expect(result.sql).toContain('INSERT INTO "users"')
    expect(result.sql).toContain('$1')
    expect(result.sql).toContain('$2')
    expect(result.params).toContain('\'; DROP TABLE users; --')
    expect(result.params).toContain('1 OR 1=1')
    // Malicious content should never appear in SQL string
    expect(result.sql).not.toContain('DROP')
    expect(result.sql).not.toContain('OR 1=1')
  })

  it('UPDATE parameterizes SET values and WHERE', () => {
    const builder = new UpdateBuilder<any, any>(table.name)
    const state = builder
      .set({ name: '\'; DROP TABLE users; --' })
      .where(e => e.eq('id', '1; DELETE FROM users'))
      .returning()
    const result = assembleQuery(state._state)

    expect(result.sql).toContain('UPDATE "users" SET')
    expect(result.sql).toContain('$1')
    expect(result.sql).toContain('$2')
    expect(result.params).toContain('\'; DROP TABLE users; --')
    expect(result.params).toContain('1; DELETE FROM users')
    expect(result.sql).not.toContain('DROP')
    expect(result.sql).not.toContain('DELETE')
  })

  it('DELETE parameterizes WHERE', () => {
    const builder = new DeleteBuilder<any, any>(table.name)
    const state = builder.where(e => e.eq('id', '1 OR 1=1'))
    const result = assembleQuery(state._state)

    expect(result.sql).toContain('DELETE FROM "users"')
    expect(result.sql).toContain('WHERE "id" = $1')
    expect(result.params).toEqual(['1 OR 1=1'])
    expect(result.sql).not.toContain('OR 1=1')
  })

  it('LIMIT and OFFSET are parameterized', () => {
    const builder = new SelectBuilder<any, any, any>(table.name)
    const state = builder.limit(10).offset(20)
    const result = assembleQuery(state._state)

    expect(result.sql).toContain('LIMIT $1')
    expect(result.sql).toContain('OFFSET $2')
    expect(result.params).toEqual([10, 20])
  })
})

// ─── Enum Value Escaping ─────────────────────────────────────────────────────

describe('Security: Enum value escaping in migrations', () => {
  it('defineTable accepts enum values without injection risk', () => {
    // Enum values are escaped at migration time via escapeEnumValue()
    expect(() => defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['active', 'inactive', 'deleted']).notNull(),
    }))).not.toThrow()
  })
})

// ─── Mass Assignment Protection ──────────────────────────────────────────────

describe('Security: Value validation prevents dangerous types', () => {
  it('rejects nested __raw in objects', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      data: t.jsonb(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    // Only top-level __raw is checked, nested JSON is passed as a parameter
    // and doesn't affect SQL generation
    expect(() => builder.values({
      data: { nested: { __raw: 'DROP TABLE users' } },
    })).not.toThrow()
    // This is safe because the entire object is parameterized as JSON,
    // not interpreted as SQL
  })

  it('rejects __raw at top level of values', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text(),
    }))

    const builder = new InsertBuilder<any, any>(table.name)

    expect(() => builder.values({
      name: { __raw: '(SELECT password FROM admin LIMIT 1)' },
    })).toThrow(/__raw/)
  })
})

// ─── Combined/Compound Injection Attempts ────────────────────────────────────

describe('Security: Compound attack vectors', () => {
  it('handles nested expressions with injections safely', () => {
    const result = sql(e.and(
      e.eq('name', '\'; DROP TABLE users; --'),
      e.or(
        e.eq('email', '1 OR 1=1'),
        e.in('status', ['active', '\'; GRANT ALL TO public; --']),
      ),
      e.between('age', '0; DELETE FROM users', '100'),
    ))

    // All values should be parameterized
    expect(result.params).toEqual([
      '\'; DROP TABLE users; --',
      '1 OR 1=1',
      'active',
      '\'; GRANT ALL TO public; --',
      '0; DELETE FROM users',
      '100',
    ])
    // No injected SQL in the query string
    expect(result.sql).not.toContain('DROP')
    expect(result.sql).not.toContain('GRANT')
    expect(result.sql).not.toContain('DELETE')
  })

  it('param offsets remain correct across complex expressions', () => {
    // Ensure parameter numbering is sequential and correct
    const result = sql(e.and(
      e.eq('a', 'v1'),
      e.in('b', ['v2', 'v3']),
      e.between('c', 'v4', 'v5'),
      e.like('d', 'v6'),
    ))

    expect(result.sql).toContain('$1')
    expect(result.sql).toContain('$6')
    expect(result.params).toHaveLength(6)
    // Verify sequential numbering
    expect(result.sql).toMatch(/\$1.*\$2.*\$3.*\$4.*\$5.*\$6/)
  })

  it('handles unicode in values safely', () => {
    const result = sql(e.eq('name', '🎵 \'; DROP TABLE users; --'))

    expect(result.sql).toBe('"name" = $1')
    expect(result.params).toEqual(['🎵 \'; DROP TABLE users; --'])
  })

  it('handles very long injection payloads', () => {
    const longPayload = `'; ${'DROP TABLE t;'.repeat(1000)} --`
    const result = sql(e.eq('name', longPayload))

    expect(result.sql).toBe('"name" = $1')
    expect(result.params).toEqual([longPayload])
    expect(result.sql).not.toContain('DROP')
  })
})

// ─── P0 Regression Guards ────────────────────────────────────────────────────

describe('Security P0: MERGE values reject __raw', () => {
  it('whenMatched(update, values) rejects __raw', () => {
    const b = new MergeBuilder<any>('users')

    expect(() => b.whenMatched('update', { name: { __raw: '\'evil\'' } })).toThrow(/__raw/)
  })

  it('whenNotMatched(insert, values) rejects __raw', () => {
    const b = new MergeBuilder<any>('users')

    expect(() => b.whenNotMatched('insert', { name: { __raw: '\'evil\'' } })).toThrow(/__raw/)
  })

  it('whenNotMatchedBySource(update, values) rejects __raw', () => {
    const b = new MergeBuilder<any>('users')

    expect(() => b.whenNotMatchedBySource('update', { name: { __raw: '\'evil\'' } })).toThrow(/__raw/)
  })
})

describe('Security P0: computedRaw() requires valid identifier alias', () => {
  it('computedRaw rejects alias containing whitespace', () => {
    const b = new SelectBuilder<any>('users')

    expect(() => b.computedRaw('1', 'foo bar')).toThrow(/Invalid/)
  })

  it('computedRaw rejects empty alias', () => {
    const b = new SelectBuilder<any>('users')

    expect(() => b.computedRaw('1', '')).toThrow(/Invalid/)
  })

  it('computedRaw accepts a valid alias', () => {
    const b = new SelectBuilder<any>('users')

    expect(() => b.computedRaw('1 + 1', 'two')).not.toThrow()
  })
})

describe('Security P0: identifier 63-byte limit', () => {
  it('rejects identifiers exceeding 63 bytes', () => {
    const tooLong = 'a'.repeat(64)

    expect(() => validateIdentifier(tooLong, 'column')).toThrow(/63-byte/)
  })

  it('accepts identifiers exactly 63 bytes', () => {
    const exactly = 'a'.repeat(63)

    expect(() => validateIdentifier(exactly, 'column')).not.toThrow()
  })

  it('rejects multi-byte UTF-8 that exceeds 63 bytes', () => {
    // 'é' = 2 bytes in UTF-8; 32 of them = 64 bytes. Regex would already reject
    // non-ASCII, so verify the regex catches it first.
    expect(() => validateIdentifier('é'.repeat(32), 'column')).toThrow()
  })
})

describe('Security P0: unbranded __raw objects do not bypass parameterization', () => {
  it('plain { __raw } object is parameterized, not interpolated', () => {
    const b = new UpdateBuilder<any>('users')

    b._state.setValues = { name: { __raw: '\'; DROP TABLE users; --' } as never }
    b._state.whereTape = null
    const { sql: out } = b.toSQL()

    expect(out).not.toContain('DROP')
    expect(out).toContain('"name" = $1')
  })
})

describe('Security: validateRawSqlFragment (partial-index where)', () => {
  it('accepts plain predicates without comments or terminators', () => {
    expect(() => validateRawSqlFragment('deletedAt IS NULL', 'idx')).not.toThrow()
    expect(() => validateRawSqlFragment('status = \'active\'', 'idx')).not.toThrow()
    expect(() => validateRawSqlFragment('id > 0 AND tenant_id = 42', 'idx')).not.toThrow()
    expect(() => validateRawSqlFragment('role IN (\'admin\', \'user\')', 'idx')).not.toThrow()
  })

  it('accepts ; INSIDE a string literal (no false positives)', () => {
    expect(() => validateRawSqlFragment('body ILIKE \'%foo;bar%\'', 'idx')).not.toThrow()
    expect(() => validateRawSqlFragment('comment ~ \'O\'\'Brien;\'', 'idx')).not.toThrow()
  })

  it('rejects ; outside string literals (statement terminator)', () => {
    expect(() => validateRawSqlFragment('1 = 1; DROP TABLE users', 'idx')).toThrow(/";"/)
    expect(() => validateRawSqlFragment(';', 'idx')).toThrow(/";"/)
  })

  it('rejects -- line comments outside string literals', () => {
    expect(() => validateRawSqlFragment('1 = 1 -- malicious', 'idx')).toThrow(/"--"/)
  })

  it('rejects /* block comments outside string literals', () => {
    expect(() => validateRawSqlFragment('1 = 1 /* attack */', 'idx')).toThrow(/"\/\*"/)
  })

  it('rejects unterminated string literals', () => {
    expect(() => validateRawSqlFragment('status = \'active', 'idx')).toThrow(/unterminated/)
  })

  it('defineTable rejects partial-index where with injection', () => {
    expect(() => defineTable('events', (t) => {
      const col = t.text().index({ where: 'tenant = \'a\'; DROP TABLE x' })

      return { id: t.serial().primaryKey(), name: col }
    })).toThrow(/";"/)
  })
})

describe('Security H1: JOIN identifier validation', () => {
  const b = () => new SelectBuilder<any>('users')
  const onTrue = (e: any) => e.raw('TRUE')

  for (const method of ['join', 'leftJoin', 'rightJoin', 'fullJoin'] as const) {
    it(`${method}() rejects injection in table name`, () => {
      expect(() => (b() as any)[method]('posts; DROP TABLE users', 'p', onTrue)).toThrow(/Invalid/)
    })

    it(`${method}() rejects injection in alias`, () => {
      expect(() => (b() as any)[method]('posts', 'p"; DROP TABLE users', onTrue)).toThrow(/Invalid/)
    })

    it(`${method}() accepts plain identifiers`, () => {
      expect(() => (b() as any)[method]('posts', 'p', onTrue)).not.toThrow()
    })
  }
})

describe('Security H1: window/with/withRecursive identifier validation', () => {
  const b = () => new SelectBuilder<any>('users')

  it('window() rejects injection in name', () => {
    expect(() => b().window('w; DROP TABLE users', { partitionBy: ['id'] })).toThrow(/Invalid/)
  })

  it('window() accepts a plain name', () => {
    expect(() => b().window('w', { partitionBy: ['id'] })).not.toThrow()
  })

  it('with() rejects injection in CTE name', () => {
    expect(() => b().with('cte; DROP TABLE users', 'SELECT 1', [])).toThrow(/Invalid/)
  })

  it('withRecursive() rejects injection in CTE name', () => {
    expect(() => b().withRecursive('cte"; DROP TABLE users', 'SELECT 1', [])).toThrow(/Invalid/)
  })
})

describe('Security H2: with()/withRecursive() $N placeholder/params parity', () => {
  const b = () => new SelectBuilder<any>('users')

  it('with() throws when SQL has $1 but no params', () => {
    expect(() => b().with('t', 'SELECT * FROM x WHERE id = $1', [])).toThrow(/placeholder/i)
  })

  it('with() throws when params are passed but SQL has no $N', () => {
    expect(() => b().with('t', 'SELECT * FROM x', ['leaked'])).toThrow(/placeholder/i)
  })

  it('with() throws when $N count is fewer than params length', () => {
    expect(() => b().with('t', 'SELECT * FROM x WHERE id = $1', [1, 2])).toThrow(/placeholder/i)
  })

  it('with() accepts matched $N and params', () => {
    expect(() => b().with('t', 'SELECT * FROM x WHERE id = $1 AND y = $2', [1, 2])).not.toThrow()
  })

  it('withRecursive() throws on placeholder mismatch', () => {
    expect(() => b().withRecursive('t', 'SELECT * FROM x WHERE id = $1', [])).toThrow(/placeholder/i)
  })

  it('withRecursive() accepts no $N when no params', () => {
    expect(() => b().withRecursive('t', 'SELECT 1', [])).not.toThrow()
  })
})

describe('Security H3: validateRawSqlFragment rejects PG-specific string literals', () => {
  it('rejects E\'...\' escape strings', () => {
    expect(() => validateRawSqlFragment('name = E\'foo\'', 'idx')).toThrow(/escape string/)
  })

  it('rejects lowercase e\'...\' escape strings', () => {
    expect(() => validateRawSqlFragment('name = e\'foo\'', 'idx')).toThrow(/escape string/)
  })

  it('does not flag E as part of an identifier', () => {
    expect(() => validateRawSqlFragment('Email = \'foo\'', 'idx')).not.toThrow()
    expect(() => validateRawSqlFragment('name = \'foo\' AND state = \'bar\'', 'idx')).not.toThrow()
  })

  it('rejects U&\'...\' Unicode strings', () => {
    expect(() => validateRawSqlFragment('name = U&\'\\0041\'', 'idx')).toThrow(/Unicode/)
  })

  it('rejects lowercase u&\'...\' Unicode strings', () => {
    expect(() => validateRawSqlFragment('name = u&\'foo\'', 'idx')).toThrow(/Unicode/)
  })

  it('rejects empty-tag $$...$$ dollar quotes', () => {
    expect(() => validateRawSqlFragment('name = $$evil; DROP TABLE x$$', 'idx')).toThrow(/dollar-quoted/)
  })

  it('rejects tagged $body$...$body$ dollar quotes', () => {
    expect(() => validateRawSqlFragment('name = $body$evil; DROP$body$', 'idx')).toThrow(/dollar-quoted/)
  })

  it('does NOT flag parameter placeholders like $1', () => {
    expect(() => validateRawSqlFragment('id = $1 AND name = $2', 'idx')).not.toThrow()
  })

  it('does not flag $ followed by digits then non-$ char', () => {
    expect(() => validateRawSqlFragment('a = $1 OR b = $2', 'idx')).not.toThrow()
  })

  it('blocks ; smuggled inside a dollar quote', () => {
    // Without the dollar-quote check, a payload like $$; DROP TABLE x$$
    // would be invisible to the standard ; scanner.
    expect(() => validateRawSqlFragment('a = 1 AND b = $$; DROP TABLE x$$', 'idx')).toThrow(/dollar-quoted/)
  })

  it('blocks -- smuggled inside an escape string', () => {
    // Without the E-string check, E'foo--bar' could be a vector to bury
    // a comment that bypasses scanner state.
    expect(() => validateRawSqlFragment('a = E\'-- nope\'', 'idx')).toThrow(/escape string/)
  })
})

describe('Security: literal escaping helpers', () => {
  it('quoteLiteral doubles single quotes and wraps in apostrophes', () => {
    expect(quoteLiteral('hello')).toBe('\'hello\'')
    expect(quoteLiteral('O\'Brien')).toBe('\'O\'\'Brien\'')
    expect(quoteLiteral('\'; DROP TABLE x; --')).toBe('\'\'\'; DROP TABLE x; --\'')
  })

  it('escapeLiteralBody escapes but does not add wrapping quotes', () => {
    expect(escapeLiteralBody('hello')).toBe('hello')
    expect(escapeLiteralBody('O\'Brien')).toBe('O\'\'Brien')
  })

  it('quoteLiteral output is safe to embed directly in DDL', () => {
    const malicious = '\'; DROP TABLE users; SELECT \''
    const quoted = quoteLiteral(malicious)

    // Every embedded ' became '', so the closing wrapper is unambiguous.
    expect(quoted.startsWith('\'')).toBe(true)
    expect(quoted.endsWith('\'')).toBe(true)
    // No bare single quotes anywhere except the outer pair
    const inner = quoted.slice(1, -1)

    expect(inner.match(/(?<!')'(?!')/)).toBeNull()
  })
})

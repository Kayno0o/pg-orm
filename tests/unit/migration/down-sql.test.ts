import type { MigrationOp } from '../../../src/migration/types'
import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { fkConstraintName } from '../../../src/migration/ddl'
import { generateDownSql, generateReverseOp } from '../../../src/migration/reverse'

function op(partial: Partial<MigrationOp> & Pick<MigrationOp, 'type' | 'sql' | 'description'>): MigrationOp {
  return { destructive: false, ...partial }
}

describe('generateReverseOp', () => {
  it('reverses create_table with DROP TABLE IF EXISTS', () => {
    expect(generateReverseOp({
      type: 'create_table',
      table: 'users',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('DROP TABLE IF EXISTS "users";')
  })

  it('drop_table reverse is a comment (irreversible)', () => {
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

  it('add_column reverses to DROP COLUMN IF EXISTS', () => {
    expect(generateReverseOp({
      type: 'add_column',
      table: 'users',
      column: 'email',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('ALTER TABLE "users" DROP COLUMN IF EXISTS "email";')
  })

  it('drop_column reverse is a comment (cannot recover original type)', () => {
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

  it('create_enum reverses to DROP TYPE IF EXISTS with extracted name', () => {
    expect(generateReverseOp({
      type: 'create_enum',
      sql: 'CREATE TYPE "user_status" AS ENUM (\'active\', \'inactive\')',
      destructive: false,
      description: '',
    })).toBe('DROP TYPE IF EXISTS "user_status";')
  })

  it('create_index reverses to DROP INDEX IF EXISTS with extracted name', () => {
    expect(generateReverseOp({
      type: 'create_index',
      sql: 'CREATE INDEX "users_email_idx" ON "users" ("email")',
      destructive: false,
      description: '',
    })).toBe('DROP INDEX IF EXISTS "users_email_idx";')
  })

  it('add_fk reverses to DROP CONSTRAINT with conventional name', () => {
    expect(generateReverseOp({
      type: 'add_fk',
      table: 'posts',
      column: 'user_id',
      sql: '',
      destructive: false,
      description: '',
    })).toBe('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_user_id_fkey";')
  })

  it('rename_column reverses to swap directions', () => {
    const rev = generateReverseOp({
      type: 'rename_column',
      table: 'users',
      sql: 'ALTER TABLE "users" RENAME COLUMN "old" TO "new"',
      destructive: false,
      description: '',
    })

    expect(rev).toBe('ALTER TABLE "users" RENAME COLUMN "new" TO "old";')
  })

  it('unknown op type returns a comment', () => {
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

describe('generateDownSql', () => {
  it('returns empty string for no ops', () => {
    expect(generateDownSql([])).toBe('')
  })

  it('reverses op order', () => {
    const out = generateDownSql([
      op({ type: 'create_table', table: 'users', sql: '', description: 'create users' }),
      op({ type: 'create_table', table: 'posts', sql: '', description: 'create posts' }),
    ])

    expect(out).toBe('DROP TABLE IF EXISTS "posts";\nDROP TABLE IF EXISTS "users";')
  })

  it('generates DROP TABLE for create_table', () => {
    const out = generateDownSql([
      op({ type: 'create_table', table: 'users', sql: '', description: '' }),
    ])

    expect(out).toBe('DROP TABLE IF EXISTS "users";')
  })

  it('generates DROP COLUMN for add_column', () => {
    const out = generateDownSql([
      op({ type: 'add_column', table: 'users', column: 'email', sql: '', description: '' }),
    ])

    expect(out).toBe('ALTER TABLE "users" DROP COLUMN IF EXISTS "email";')
  })

  it('generates DROP CONSTRAINT for add_fk with canonical name', () => {
    const out = generateDownSql([
      op({ type: 'add_fk', table: 'posts', column: 'author_id', sql: '', description: '' }),
    ])

    expect(out).toBe('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_author_id_fkey";')
  })

  it('generates DROP INDEX from QUOTED_IDENT match', () => {
    const out = generateDownSql([
      op({ type: 'create_index', sql: 'CREATE INDEX "users_email_idx" ON "users" ("email")', description: '' }),
    ])

    expect(out).toBe('DROP INDEX IF EXISTS "users_email_idx";')
  })

  it('reverses RENAME COLUMN to its inverse', () => {
    const out = generateDownSql([
      op({
        type: 'rename_column',
        table: 'users',
        sql: 'ALTER TABLE "users" RENAME COLUMN "old_name" TO "new_name"',
        description: '',
      }),
    ])

    expect(out).toBe('ALTER TABLE "users" RENAME COLUMN "new_name" TO "old_name";')
  })

  it('falls back to comment for unreversible ops', () => {
    const out = generateDownSql([
      op({ type: 'drop_table', sql: '', description: 'drop users' }),
    ])

    expect(out).toBe('-- Cannot reverse: drop users')
  })

  it('names the op each statement reverts, keeping a description with a line break on its comment line', () => {
    const out = generateDownSql([
      op({ type: 'create_table', table: 'users', sql: '', description: 'Create table "users"' }),
      op({ type: 'alter_enum_remove', sql: '', description: 'Replace enum "e" without values: a\nDROP TABLE users;' }),
    ], { comments: true })

    expect(out).toBe('-- Cannot reverse: Replace enum "e" without values: a DROP TABLE users;\n\n-- Revert: Create table "users"\nDROP TABLE IF EXISTS "users";')
  })

  describe('identifier validation (defense-in-depth)', () => {
    it('rejects table name with quote injection attempt', () => {
      expect(() =>
        generateDownSql([
          op({ type: 'create_table', table: 'users"; DROP TABLE secrets; --', sql: '', description: '' }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('rejects column with semicolon', () => {
      expect(() =>
        generateDownSql([
          op({ type: 'add_column', table: 'users', column: 'x; DROP TABLE y', sql: '', description: '' }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('rejects table starting with digit', () => {
      expect(() =>
        generateDownSql([
          op({ type: 'create_table', table: '1users', sql: '', description: '' }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('rejects undefined table', () => {
      expect(() =>
        generateDownSql([
          op({ type: 'create_table', sql: '', description: '' }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('rejects undefined column on add_column', () => {
      expect(() =>
        generateDownSql([
          op({ type: 'add_column', table: 'users', sql: '', description: '' }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('drops a long fk constraint under the name it was created with, within the 63-byte limit', () => {
      const longTable = 'a'.repeat(40)
      const longColumn = 'b'.repeat(40)
      const sql = generateDownSql([op({ type: 'add_fk', table: longTable, column: longColumn, sql: '', description: '' })], { validate: true })

      expect(sql).toBe(`ALTER TABLE "${longTable}" DROP CONSTRAINT IF EXISTS "${fkConstraintName(longTable, longColumn)}";`)
      expect(fkConstraintName(longTable, longColumn)).toHaveLength(63)
    })

    it('rejects rename_column when matched names are valid but table is malicious', () => {
      expect(() =>
        generateDownSql([
          op({
            type: 'rename_column',
            table: 'users"; DROP TABLE x; --',
            sql: 'ALTER TABLE "users" RENAME COLUMN "old" TO "new"',
            description: '',
          }),
        ], { validate: true }),
      ).toThrow(ValidationError)
    })

    it('returns empty for rename_column when sql does not match RENAME_COLUMN_RE', () => {
      const out = generateDownSql([
        op({ type: 'rename_column', table: 'users', sql: 'NOT A RENAME', description: '' }),
      ])

      expect(out).toBe('')
    })

    it('returns empty for create_index when sql has no quoted identifier', () => {
      const out = generateDownSql([
        op({ type: 'create_index', sql: 'CREATE INDEX unquoted ON something', description: '' }),
      ])

      expect(out).toBe('')
    })

    it('does not validate when validate option is false', () => {
      const out = generateDownSql([
        op({ type: 'create_table', table: '1users', sql: '', description: '' }),
      ])

      expect(out).toBe('DROP TABLE IF EXISTS "1users";')
    })
  })

  describe('consistency between callers', () => {
    it('produces identical down SQL for create_enum in migration files and sync history', () => {
      const enumOp = op({
        type: 'create_enum',
        sql: 'CREATE TYPE "user_status" AS ENUM (\'active\', \'inactive\')',
        description: 'Create enum type "user_status"',
      })

      const migrationFileDown = generateDownSql([enumOp])
      const syncHistoryDown = generateDownSql([enumOp], { validate: true })

      expect(migrationFileDown).toBe(syncHistoryDown)
      expect(migrationFileDown).toBe('DROP TYPE IF EXISTS "user_status";')
    })
  })
})

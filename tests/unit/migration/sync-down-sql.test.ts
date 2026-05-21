import type { MigrationOp } from '../../../src/migration/types'
import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { buildSyncDownSql } from '../../../src/migration/sync'

function op(partial: Partial<MigrationOp> & Pick<MigrationOp, 'type' | 'sql' | 'description'>): MigrationOp {
  return { destructive: false, ...partial }
}

describe('buildSyncDownSql', () => {
  it('returns empty string for no ops', () => {
    expect(buildSyncDownSql([])).toBe('')
  })

  it('reverses op order', () => {
    const out = buildSyncDownSql([
      op({ type: 'create_table', table: 'users', sql: '', description: 'create users' }),
      op({ type: 'create_table', table: 'posts', sql: '', description: 'create posts' }),
    ])

    expect(out).toBe('DROP TABLE IF EXISTS "posts";\nDROP TABLE IF EXISTS "users";')
  })

  it('generates DROP TABLE for create_table', () => {
    const out = buildSyncDownSql([
      op({ type: 'create_table', table: 'users', sql: '', description: '' }),
    ])

    expect(out).toBe('DROP TABLE IF EXISTS "users";')
  })

  it('generates DROP COLUMN for add_column', () => {
    const out = buildSyncDownSql([
      op({ type: 'add_column', table: 'users', column: 'email', sql: '', description: '' }),
    ])

    expect(out).toBe('ALTER TABLE "users" DROP COLUMN IF EXISTS "email";')
  })

  it('generates DROP CONSTRAINT for add_fk with canonical name', () => {
    const out = buildSyncDownSql([
      op({ type: 'add_fk', table: 'posts', column: 'author_id', sql: '', description: '' }),
    ])

    expect(out).toBe('ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_author_id_fkey";')
  })

  it('generates DROP INDEX from QUOTED_IDENT match', () => {
    const out = buildSyncDownSql([
      op({ type: 'create_index', sql: 'CREATE INDEX "users_email_idx" ON "users" ("email")', description: '' }),
    ])

    expect(out).toBe('DROP INDEX IF EXISTS "users_email_idx";')
  })

  it('reverses RENAME COLUMN to its inverse', () => {
    const out = buildSyncDownSql([
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
    const out = buildSyncDownSql([
      op({ type: 'drop_table', sql: '', description: 'drop users' }),
    ])

    expect(out).toBe('-- Cannot reverse: drop users')
  })

  describe('identifier validation (defense-in-depth)', () => {
    it('rejects table name with quote injection attempt', () => {
      expect(() =>
        buildSyncDownSql([
          op({ type: 'create_table', table: 'users"; DROP TABLE secrets; --', sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects column with semicolon', () => {
      expect(() =>
        buildSyncDownSql([
          op({ type: 'add_column', table: 'users', column: 'x; DROP TABLE y', sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects table starting with digit', () => {
      expect(() =>
        buildSyncDownSql([
          op({ type: 'create_table', table: '1users', sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects undefined table', () => {
      expect(() =>
        buildSyncDownSql([
          op({ type: 'create_table', sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects undefined column on add_column', () => {
      expect(() =>
        buildSyncDownSql([
          op({ type: 'add_column', table: 'users', sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects fk constraint that would exceed PG 63-byte identifier limit', () => {
      const longTable = 'a'.repeat(40)
      const longColumn = 'b'.repeat(40)

      expect(() =>
        buildSyncDownSql([
          op({ type: 'add_fk', table: longTable, column: longColumn, sql: '', description: '' }),
        ]),
      ).toThrow(ValidationError)
    })

    it('rejects rename_column when matched names are valid but table is malicious', () => {
      expect(() =>
        buildSyncDownSql([
          op({
            type: 'rename_column',
            table: 'users"; DROP TABLE x; --',
            sql: 'ALTER TABLE "users" RENAME COLUMN "old" TO "new"',
            description: '',
          }),
        ]),
      ).toThrow(ValidationError)
    })

    it('returns empty for rename_column when sql does not match RENAME_COLUMN_RE', () => {
      const out = buildSyncDownSql([
        op({ type: 'rename_column', table: 'users', sql: 'NOT A RENAME', description: '' }),
      ])

      expect(out).toBe('')
    })

    it('returns empty for create_index when sql has no quoted identifier', () => {
      const out = buildSyncDownSql([
        op({ type: 'create_index', sql: 'CREATE INDEX unquoted ON something', description: '' }),
      ])

      expect(out).toBe('')
    })
  })
})

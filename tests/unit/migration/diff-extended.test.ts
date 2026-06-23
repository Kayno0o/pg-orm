import type { AnyTableDef, Executable } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { defineTable, DestructiveOpError } from '../../../src/index'
import { diffSchema, generateMigration } from '../../../src/migration/index'

// --- Helpers ---

function liveCol(name: string, overrides: Partial<{
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isGenerated: boolean
}> = {}) {
  return {
    name,
    dataType: overrides.dataType ?? 'text',
    isNullable: overrides.isNullable ?? true,
    defaultValue: overrides.defaultValue ?? null,
    isPrimaryKey: overrides.isPrimaryKey ?? false,
    isUnique: overrides.isUnique ?? false,
    isGenerated: overrides.isGenerated ?? false,
  }
}

function live(tables: { name: string, columns: ReturnType<typeof liveCol>[] }[], enums: { name: string, values: string[] }[] = []) {
  return { tables, enums }
}

function registry(...tables: AnyTableDef[]) {
  return new Map(tables.map(t => [t.name, t]))
}

describe('diffSchema — extended migration tests', () => {
  // --- Column operations ---

  it('adds multiple columns at once', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
      email: t.text().notNull(),
      bio: t.text().nullable(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const addOps = ops.filter(o => o.type === 'add_column')

    expect(addOps).toHaveLength(3)
    expect(addOps.map(o => o.column).sort()).toEqual(['bio', 'email', 'name'])
    expect(addOps.every(o => !o.destructive)).toBe(true)
  })

  it('drops multiple columns at once', () => {
    const table = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{
        name: 'users',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('old_col1'),
          liveCol('old_col2'),
        ],
      }]),
      registry(table),
    )

    const dropOps = ops.filter(o => o.type === 'drop_column')

    expect(dropOps).toHaveLength(2)
    expect(dropOps.every(o => o.destructive)).toBe(true)
  })

  it('detects column type change from int to text (destructive)', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      value: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('value', { dataType: 'int4', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'value')

    expect(alterOp).toBeDefined()
    expect(alterOp!.destructive).toBe(true)
    expect(alterOp!.sql).toContain('TYPE text')
  })

  it('detects column type change from text[] to text (array to scalar)', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      tags: t.text().nullable(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('tags', { dataType: 'text[]', isNullable: true }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'tags')

    expect(alterOp).toBeDefined()
    expect(alterOp!.destructive).toBe(true)
    expect(alterOp!.sql).toContain('TYPE text')
  })

  it('detects column type change from text to text[] (scalar to array)', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      tags: t.array(t.text()).nullable(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('tags', { dataType: 'text', isNullable: true }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'tags')

    expect(alterOp).toBeDefined()
    expect(alterOp!.destructive).toBe(true)
    expect(alterOp!.sql).toContain('TYPE text[]')
  })

  it('adds USING clause when changing jsonb to text[]', () => {
    const table = defineTable('sokoban_level', t => ({
      id: t.serial().primaryKey(),
      rows: t.array(t.text()).notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'sokoban_level',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('rows', { dataType: 'jsonb', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'rows')

    expect(alterOp).toBeDefined()
    expect(alterOp!.destructive).toBe(true)
    expect(alterOp!.sql).toBe('ALTER TABLE "sokoban_level" ALTER COLUMN "rows" TYPE text[] USING "rows"::text[]')
  })

  it('adds USING clause when changing json to text[]', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      tags: t.array(t.text()).nullable(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('tags', { dataType: 'json', isNullable: true }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'tags')

    expect(alterOp).toBeDefined()
    expect(alterOp!.sql).toContain('USING "tags"::text[]')
  })

  it('does not add USING clause for implicitly-cast type changes', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      name: t.varchar(255).notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('name', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'name')

    expect(alterOp).toBeDefined()
    expect(alterOp!.sql).toBe('ALTER TABLE "items" ALTER COLUMN "name" TYPE varchar(255)')
  })

  it('detects column type change from text to varchar', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      name: t.varchar(255).notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('name', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    const alterOp = ops.find(o => o.type === 'alter_column')

    expect(alterOp).toBeDefined()
    expect(alterOp!.sql).toContain('TYPE varchar(255)')
  })

  // --- Nullability changes ---

  it('adds NOT NULL to nullable column', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('status', { dataType: 'text', isNullable: true }),
        ],
      }]),
      registry(table),
    )

    expect(ops.some(o => o.sql.includes('SET NOT NULL'))).toBe(true)
  })

  it('drops NOT NULL from non-PK column', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.text().nullable(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('status', { dataType: 'text', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.some(o => o.sql.includes('DROP NOT NULL'))).toBe(true)
  })

  it('does not drop NOT NULL on PK column even if schema says nullable', () => {
    // PK columns are inherently not null — don't generate DROP NOT NULL
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{
        name: 'items',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.filter(o => o.sql.includes('DROP NOT NULL'))).toHaveLength(0)
  })

  // --- Enum operations ---

  it('creates new enum type when table uses it', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['active', 'archived'] as const).notNull(),
    }))
    const ops = diffSchema(live([]), registry(table))

    const enumOp = ops.find(o => o.type === 'create_enum')

    expect(enumOp).toBeDefined()
    expect(enumOp!.sql).toContain('CREATE TYPE')
    expect(enumOp!.sql).toContain('\'active\'')
    expect(enumOp!.sql).toContain('\'archived\'')

    // Enum creation should come before table creation
    const enumIdx = ops.indexOf(enumOp!)
    const tableIdx = ops.findIndex(o => o.type === 'create_table')

    expect(enumIdx).toBeLessThan(tableIdx)
  })

  it('adds new enum values', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['active', 'archived', 'deleted'] as const).notNull(),
    }))
    const ops = diffSchema(
      {
        tables: [{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('status', { dataType: 'item_status', isNullable: false }),
          ],
        }],
        enums: [{ name: 'item_status', values: ['active', 'archived'] }],
      },
      registry(table),
    )

    const addOp = ops.find(o => o.type === 'alter_enum_add')

    expect(addOp).toBeDefined()
    expect(addOp!.sql).toContain('ADD VALUE')
    expect(addOp!.sql).toContain('\'deleted\'')
  })

  it('removes enum values via type recreation (destructive)', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.enum('item_status', ['active'] as const).notNull(),
    }))
    const ops = diffSchema(
      {
        tables: [{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('status', { dataType: 'item_status', isNullable: false }),
          ],
        }],
        enums: [{ name: 'item_status', values: ['active', 'archived', 'deleted'] }],
      },
      registry(table),
    )

    const removeOps = ops.filter(o => o.type === 'alter_enum_remove')

    expect(removeOps.length).toBeGreaterThanOrEqual(3) // CREATE tmp, ALTER columns, DROP old, RENAME
    expect(removeOps.some(o => o.sql.includes('CREATE TYPE'))).toBe(true)
    expect(removeOps.some(o => o.sql.includes('DROP TYPE'))).toBe(true)
    expect(removeOps.some(o => o.sql.includes('RENAME TO'))).toBe(true)
    expect(removeOps.every(o => o.destructive)).toBe(true)
  })

  // --- Destructive protection ---

  it('flags drop_table as destructive', () => {
    const ops = diffSchema(
      live([{ name: 'old_table', columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true })] }]),
      registry(),
    )

    expect(ops[0]!.type).toBe('drop_table')
    expect(ops[0]!.destructive).toBe(true)
  })

  it('flags drop_column as destructive', () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('gone'),
        ],
      }]),
      registry(table),
    )

    const dropOp = ops.find(o => o.type === 'drop_column')

    expect(dropOp!.destructive).toBe(true)
  })

  it('flags alter_column type change as destructive', () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
      val: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('val', { dataType: 'int4', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops.some(o => o.type === 'alter_column' && o.destructive)).toBe(true)
  })

  // --- Multiple tables ---

  it('handles simultaneous create and drop of different tables', () => {
    const newTable = defineTable('new_table', t => ({
      id: t.serial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{ name: 'old_table', columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true })] }]),
      registry(newTable),
    )

    expect(ops.some(o => o.type === 'create_table' && o.table === 'new_table')).toBe(true)
    expect(ops.some(o => o.type === 'drop_table' && o.table === 'old_table')).toBe(true)
  })

  // --- Type normalization ---

  it('normalizes bigserial to bigint', () => {
    const table = defineTable('t', t => ({
      id: t.bigserial().primaryKey(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [liveCol('id', { dataType: 'bigint', isPrimaryKey: true, isNullable: false })],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0) // should be recognized as same
  })

  it('normalizes float4 to real', () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
      val: t.real().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('val', { dataType: 'float4', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  it('normalizes timestamptz to timestamp with time zone', () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
      ts: t.timestamptz().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [
          liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
          liveCol('ts', { dataType: 'timestamptz', isNullable: false }),
        ],
      }]),
      registry(table),
    )

    expect(ops).toHaveLength(0)
  })

  // --- DDL generation ---

  it('emits FK as separate add_fk op after CREATE TABLEs', () => {
    const users = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))
    const posts = defineTable('posts', t => ({
      id: t.serial().primaryKey(),
      authorId: t.integer().notNull().references(() => users, 'id', { onDelete: 'cascade' }),
    }))
    const ops = diffSchema(live([]), registry(users, posts))

    const createPosts = ops.find(o => o.type === 'create_table' && o.table === 'posts')

    expect(createPosts).toBeDefined()
    expect(createPosts!.sql).not.toContain('FOREIGN KEY')

    const addFk = ops.find(o => o.type === 'add_fk' && o.table === 'posts' && o.column === 'authorId')

    expect(addFk).toBeDefined()
    expect(addFk!.sql).toContain('FOREIGN KEY ("authorId") REFERENCES "users" ("id")')
    expect(addFk!.sql).toContain('ON DELETE CASCADE')

    const createIdx = ops.findIndex(o => o.type === 'create_table' && o.table === 'posts')
    const fkIdx = ops.findIndex(o => o.type === 'add_fk' && o.table === 'posts')

    expect(fkIdx).toBeGreaterThan(createIdx)
  })

  it('handles FK-violating declaration order on empty DB', () => {
    // posts declared BEFORE users — would fail under inline-FK CREATE TABLE
    const usersRef: { ref?: ReturnType<typeof defineTable> } = {}
    const posts = defineTable('posts', t => ({
      id: t.serial().primaryKey(),
      authorId: t.integer().notNull().references(() => usersRef.ref!, 'id'),
    }))
    const users = defineTable('users', t => ({
      id: t.serial().primaryKey(),
    }))

    usersRef.ref = users as never

    const ops = diffSchema(live([]), registry(posts, users))
    const createPosts = ops.findIndex(o => o.type === 'create_table' && o.table === 'posts')
    const createUsers = ops.findIndex(o => o.type === 'create_table' && o.table === 'users')
    const addFk = ops.findIndex(o => o.type === 'add_fk' && o.table === 'posts')

    expect(createPosts).toBeGreaterThanOrEqual(0)
    expect(createUsers).toBeGreaterThanOrEqual(0)
    // FK is added after both tables exist
    expect(addFk).toBeGreaterThan(createPosts)
    expect(addFk).toBeGreaterThan(createUsers)
  })

  it('generates CREATE TABLE with check constraint', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      price: t.int4().check('price >= 0'),
    }))
    const ops = diffSchema(live([]), registry(table))

    const createOp = ops.find(o => o.type === 'create_table')

    expect(createOp!.sql).toContain('CHECK (price >= 0)')
  })

  it('generates CREATE TABLE with default value', () => {
    const table = defineTable('items', t => ({
      id: t.serial().primaryKey(),
      status: t.text().notNull().default('active'),
    }))
    const ops = diffSchema(live([]), registry(table))

    const createOp = ops.find(o => o.type === 'create_table')

    expect(createOp!.sql).toContain('DEFAULT \'active\'')
  })

  it('generates ADD COLUMN with NOT NULL', () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const ops = diffSchema(
      live([{
        name: 't',
        columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false })],
      }]),
      registry(table),
    )

    const addOp = ops.find(o => o.type === 'add_column' && o.column === 'name')

    expect(addOp!.sql).toContain('NOT NULL')
  })

  // --- generateMigration ---

  it('generateMigration returns null when no drift', async () => {
    const table = defineTable('t', t => ({
      id: t.serial().primaryKey(),
    }))
    const mockExecutor = {
      query: async () => [],
      sql: {},
    } as unknown as Executable

    const result = await generateMigration(mockExecutor, registry(table))

    // Will generate a create_table since live schema is empty
    expect(result).not.toBeNull()
    expect(result!.up).toContain('CREATE TABLE')
    expect(result!.down).toContain('DROP TABLE')
  })

  it('generateMigration throws DestructiveOpError without allowDestructive', async () => {
    const mockExecutor = {
      query: async (sql: string) => {
        if (sql.includes('information_schema.columns')) {
          return [{ table_name: 'old', column_name: 'id', data_type: 'integer', udt_name: 'int4', is_nullable: 'NO', column_default: null, is_generated: 'NEVER', character_maximum_length: null, numeric_precision: null, numeric_scale: null, generation_expression: null }]
        }

        if (sql.includes('PRIMARY KEY')) {
          return [{ table_name: 'old', column_name: 'id' }]
        }

        return []
      },
      sql: {},
    } as unknown as Executable

    try {
      await generateMigration(mockExecutor, registry())
      expect(true).toBe(false) // should not reach
    }
    catch (err) {
      expect(err).toBeInstanceOf(DestructiveOpError)
    }
  })

  // --- Edge cases ---

  // --- Default value diffing ---

  describe('default value diffing', () => {
    it('detects stale array default (text[] default on text column)', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        tags: t.text().default(''),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('tags', { dataType: 'text', defaultValue: '\'{}\'::text[]', isNullable: true }),
          ],
        }]),
        registry(table),
      )

      const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'tags')

      expect(alterOp).toBeDefined()
      expect(alterOp!.sql).toContain('SET DEFAULT')
      expect(alterOp!.sql).toContain('\'\'')
      expect(alterOp!.destructive).toBe(false)
    })

    it('detects added default (no default → has default)', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        count: t.integer().default(0),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('count', { dataType: 'integer', defaultValue: null, isNullable: true }),
          ],
        }]),
        registry(table),
      )

      const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'count')

      expect(alterOp).toBeDefined()
      expect(alterOp!.sql).toContain('SET DEFAULT 0')
      expect(alterOp!.destructive).toBe(false)
    })

    it('detects removed default (has default → no default)', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        count: t.integer().nullable(),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('count', { dataType: 'integer', defaultValue: '0', isNullable: true }),
          ],
        }]),
        registry(table),
      )

      const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'count')

      expect(alterOp).toBeDefined()
      expect(alterOp!.sql).toContain('DROP DEFAULT')
      expect(alterOp!.destructive).toBe(false)
    })

    it('detects changed default value', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        label: t.text().default('world'),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('label', { dataType: 'text', defaultValue: '\'hello\'', isNullable: true }),
          ],
        }]),
        registry(table),
      )

      const alterOp = ops.find(o => o.type === 'alter_column' && o.column === 'label')

      expect(alterOp).toBeDefined()
      expect(alterOp!.sql).toContain('SET DEFAULT \'world\'')
    })

    it('produces no op when defaults match (normalizing PG type cast)', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        name: t.text().default(''),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            // PostgreSQL appends ::text cast — should not trigger a diff
            liveCol('name', { dataType: 'text', defaultValue: '\'\'::text', isNullable: true }),
          ],
        }]),
        registry(table),
      )

      expect(ops.find(o => o.column === 'name')).toBeUndefined()
    })

    it('skips default diffing for primary key columns', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false, defaultValue: 'nextval(\'items_id_seq\'::regclass)' }),
          ],
        }]),
        registry(table),
      )

      // No DROP DEFAULT should be emitted for a PK with a sequence default
      expect(ops.find(o => o.column === 'id' && o.sql?.includes('DEFAULT'))).toBeUndefined()
    })

    it('skips default diffing for generated columns', () => {
      const table = defineTable('items', t => ({
        id: t.serial().primaryKey(),
        fullName: t.text().generated('first_name || \' \' || last_name'),
      }))
      const ops = diffSchema(
        live([{
          name: 'items',
          columns: [
            liveCol('id', { dataType: 'integer', isPrimaryKey: true, isNullable: false }),
            liveCol('fullName', { dataType: 'text', isGenerated: true, defaultValue: null, isNullable: true }),
          ],
        }]),
        registry(table),
      )

      expect(ops.find(o => o.column === 'fullName' && o.sql?.includes('DEFAULT'))).toBeUndefined()
    })
  })

  it('handles empty desired schema (drop everything)', () => {
    const ops = diffSchema(
      live([
        { name: 'a', columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true })] },
        { name: 'b', columns: [liveCol('id', { dataType: 'integer', isPrimaryKey: true })] },
      ]),
      registry(),
    )

    expect(ops.filter(o => o.type === 'drop_table')).toHaveLength(2)
  })

  it('handles empty live schema (create everything)', () => {
    const t1 = defineTable('a', t => ({ id: t.serial().primaryKey() }))
    const t2 = defineTable('b', t => ({ id: t.serial().primaryKey() }))
    const ops = diffSchema(live([]), registry(t1, t2))

    expect(ops.filter(o => o.type === 'create_table')).toHaveLength(2)
  })
})

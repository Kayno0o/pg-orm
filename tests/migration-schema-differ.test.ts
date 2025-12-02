import type { DatabaseColumn, DatabaseIndex, DatabaseSchema, ForeignKeyInfo } from '../src/migration/types'
import { describe, expect, test } from 'bun:test'
import { orm } from '../src'
import { SchemaDiffer } from '../src/migration/schema-differ'

// ============================================================================
// Unit Tests - SchemaDiffer (No Database Required)
// ============================================================================

describe('SchemaDiffer Unit Tests', () => {
  // Helper to create empty database schema
  const createEmptySchema = (): DatabaseSchema => ({
    tables: new Map(),
    columns: new Map(),
    constraints: new Map(),
    indexes: new Map(),
    foreignKeys: new Map(),
  })

  // Helper to create mock database column
  const createColumn = (
    tableName: string,
    columnName: string,
    dataType: string,
    isNullable = false,
    columnDefault: string | null = null,
  ): DatabaseColumn => ({
    tableName,
    columnName,
    dataType,
    isNullable,
    columnDefault,
    characterMaximumLength: null,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
    udtName: dataType,
  })

  describe('CREATE_TABLE detection', () => {
    test('should detect new table', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string().unique(),
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()
      const diff = await differ.diff(dbSchema)

      expect(diff.hasChanges).toBe(true)
      expect(diff.hasDestructiveChanges).toBe(false)

      const createTableChange = diff.changes.find(c => c.type === 'CREATE_TABLE')

      expect(createTableChange).toBeDefined()
      expect(createTableChange?.tableName).toBe('users')
      expect(createTableChange?.sql).toContain('CREATE TABLE users')
      expect(createTableChange?.sql).toContain('id SERIAL PRIMARY KEY')
      expect(createTableChange?.sql).toContain('name TEXT NOT NULL')
      expect(createTableChange?.sql).toContain('email TEXT NOT NULL')
      expect(createTableChange?.sql).toContain('UNIQUE')
    })

    test('should create table with all field types', async () => {
      const Product = orm.entity('products', {
        name: orm.string(),
        price: orm.number(),
        stock: orm.number().integer(),
        active: orm.boolean().default(true),
        metadata: orm.jsonb(),
        tags: orm.array('string'),
        status: orm.enum(['draft', 'published', 'archived']),
        uuid: orm.uuid(),
        createdAt: orm.timestamp().default('NOW()'),
        publishedDate: orm.date().nullable(),
      }).build()

      const entities = new Map([[Product.tableName, Product]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()
      const diff = await differ.diff(dbSchema)

      const createTableChange = diff.changes.find(c => c.type === 'CREATE_TABLE')

      expect(createTableChange?.sql).toContain('name TEXT NOT NULL')
      expect(createTableChange?.sql).toContain('price DOUBLE PRECISION NOT NULL')
      expect(createTableChange?.sql).toContain('stock INTEGER NOT NULL')
      expect(createTableChange?.sql).toContain('active BOOLEAN NOT NULL DEFAULT true')
      expect(createTableChange?.sql).toContain('metadata JSONB NOT NULL')
      expect(createTableChange?.sql).toContain('tags TEXT[] NOT NULL')
      expect(createTableChange?.sql).toContain('status TEXT NOT NULL')
      expect(createTableChange?.sql).toContain('uuid UUID NOT NULL')
      expect(createTableChange?.sql).toContain('created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()')
      expect(createTableChange?.sql).toContain('published_date DATE')
    })
  })

  describe('ADD_COLUMN detection', () => {
    test('should detect new column in existing table', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string(),
        bio: orm.string().nullable(), // New column
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      // Existing schema with users table
      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'email', 'text'),
      ])

      const diff = await differ.diff(dbSchema)

      const addColumnChange = diff.changes.find(
        c => c.type === 'ADD_COLUMN' && c.metadata?.columnName === 'bio',
      )

      expect(addColumnChange).toBeDefined()
      expect(addColumnChange?.sql).toContain('ALTER TABLE users ADD COLUMN bio TEXT')
      expect(addColumnChange?.description).toContain('Add column users.bio')
    })
  })

  describe('MODIFY_COLUMN detection', () => {
    test('should detect column type change', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        age: orm.number().integer(), // Changed from DOUBLE PRECISION
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'age', 'double precision'), // Currently DOUBLE PRECISION
      ])

      const diff = await differ.diff(dbSchema)

      const modifyColumnChange = diff.changes.find(
        c => c.type === 'MODIFY_COLUMN' && c.metadata?.columnName === 'age',
      )

      expect(modifyColumnChange).toBeDefined()
      expect(modifyColumnChange?.sql).toContain('ALTER TABLE users ALTER COLUMN age TYPE INTEGER')
    })

    test('should detect nullable change', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        bio: orm.string(), // Now required (was nullable)
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'bio', 'text', true), // Currently nullable
      ])

      const diff = await differ.diff(dbSchema)

      const modifyNullableChange = diff.changes.find(
        c => c.type === 'MODIFY_COLUMN'
          && c.metadata?.columnName === 'bio'
          && c.sql.includes('SET NOT NULL'),
      )

      expect(modifyNullableChange).toBeDefined()
      expect(modifyNullableChange?.sql).toContain('ALTER TABLE users ALTER COLUMN bio SET NOT NULL')
    })

    test('should detect default value change', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        active: orm.boolean().default(true), // Added default
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'active', 'boolean', false, null), // No default
      ])

      const diff = await differ.diff(dbSchema)

      const modifyDefaultChange = diff.changes.find(
        c => c.type === 'MODIFY_COLUMN'
          && c.metadata?.columnName === 'active'
          && c.sql.includes('SET DEFAULT'),
      )

      expect(modifyDefaultChange).toBeDefined()
      expect(modifyDefaultChange?.sql).toContain('ALTER TABLE users ALTER COLUMN active SET DEFAULT true')
    })
  })

  describe('UNIQUE constraint detection', () => {
    test('should detect missing unique constraint', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string().unique(), // Should be unique
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'email', 'text'), // No unique constraint
      ])
      dbSchema.indexes.set('users', [])

      const diff = await differ.diff(dbSchema)

      const addUniqueChange = diff.changes.find(
        c => c.type === 'ADD_CONSTRAINT' && c.metadata?.columnName === 'email',
      )

      expect(addUniqueChange).toBeDefined()
      expect(addUniqueChange?.sql).toContain('ADD CONSTRAINT')
      expect(addUniqueChange?.sql).toContain('UNIQUE (email)')
    })

    test('should detect extra unique constraint in safe mode', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string(), // Not unique in entity
      }).build()

      const entities = new Map([[User.tableName, User]])

      // Safe mode - should NOT drop
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'email', 'text'),
      ])
      dbSchema.indexes.set('users', [
        {
          indexName: 'users_email_key',
          tableName: 'users',
          columnNames: ['email'],
          isUnique: true,
          isPrimary: false,
        } as DatabaseIndex,
      ])

      const diff = await differ.diff(dbSchema)

      // Should NOT suggest dropping in safe mode
      const dropUniqueChange = diff.changes.find(
        c => c.type === 'DROP_CONSTRAINT' && c.metadata?.columnName === 'email',
      )

      expect(dropUniqueChange).toBeUndefined()
    })

    test('should detect extra unique constraint in unsafe mode', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string(), // Not unique in entity
      }).build()

      const entities = new Map([[User.tableName, User]])

      // Unsafe mode - should drop
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: false,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'email', 'text'),
      ])
      dbSchema.indexes.set('users', [
        {
          indexName: 'users_email_key',
          tableName: 'users',
          columnNames: ['email'],
          isUnique: true,
          isPrimary: false,
        } as DatabaseIndex,
      ])

      const diff = await differ.diff(dbSchema)

      // Should suggest dropping in unsafe mode
      const dropUniqueChange = diff.changes.find(
        c => c.type === 'DROP_CONSTRAINT' && c.metadata?.columnName === 'email',
      )

      expect(dropUniqueChange).toBeDefined()
      expect(dropUniqueChange?.sql).toContain('DROP CONSTRAINT')
      expect(dropUniqueChange?.destructive).toBe(true)
    })
  })

  describe('FOREIGN KEY detection', () => {
    test('should detect new foreign key', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('posts', {
        title: orm.string(),
        authorId: orm.foreignKey('users'),
      }).build()

      const entities = new Map<string, any>([
        [User.tableName, User],
        [Post.tableName, Post],
      ])

      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      // Both tables exist, but FK doesn't
      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.tables.set('posts', { tableName: 'posts', schemaName: 'public' })
      dbSchema.columns.set('users', [createColumn('users', 'id', 'integer')])
      dbSchema.columns.set('posts', [
        createColumn('posts', 'id', 'integer'),
        createColumn('posts', 'title', 'text'),
        createColumn('posts', 'author_id', 'integer'),
      ])
      dbSchema.foreignKeys.set('posts', [])

      const diff = await differ.diff(dbSchema)

      const addFKChange = diff.changes.find(
        c => c.type === 'ADD_FOREIGN_KEY' && c.metadata?.columnName === 'author_id',
      )

      expect(addFKChange).toBeDefined()
      expect(addFKChange?.sql).toContain('ADD CONSTRAINT')
      expect(addFKChange?.sql).toContain('FOREIGN KEY (author_id)')
      expect(addFKChange?.sql).toContain('REFERENCES users(id)')
    })

    test('should detect modified foreign key', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
      }).build()

      const Post = orm.entity('posts', {
        title: orm.string(),
        authorId: orm.foreignKey('users').onDelete('CASCADE'), // Changed to CASCADE
      }).build()

      const entities = new Map<string, any>([
        [User.tableName, User],
        [Post.tableName, Post],
      ])

      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.tables.set('posts', { tableName: 'posts', schemaName: 'public' })
      dbSchema.columns.set('users', [createColumn('users', 'id', 'integer')])
      dbSchema.columns.set('posts', [
        createColumn('posts', 'id', 'integer'),
        createColumn('posts', 'title', 'text'),
        createColumn('posts', 'author_id', 'integer'),
      ])
      dbSchema.foreignKeys.set('posts', [
        {
          constraintName: 'fk_posts_author_id',
          tableName: 'posts',
          columnName: 'author_id',
          foreignTableName: 'users',
          foreignColumnName: 'id',
          onDelete: 'NO ACTION', // Currently NO ACTION
          onUpdate: 'NO ACTION',
        } as ForeignKeyInfo,
      ])

      const diff = await differ.diff(dbSchema)

      // Should drop old FK
      const dropFKChange = diff.changes.find(c => c.type === 'DROP_FOREIGN_KEY')

      expect(dropFKChange).toBeDefined()

      // Should add new FK with CASCADE
      const addFKChange = diff.changes.find(c => c.type === 'ADD_FOREIGN_KEY')

      expect(addFKChange).toBeDefined()
      expect(addFKChange?.sql).toContain('ON DELETE CASCADE')
    })
  })

  describe('DROP_TABLE detection', () => {
    test('should not drop table in safe mode', async () => {
      const entities = new Map() // No entities

      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('old_table', { tableName: 'old_table', schemaName: 'public' })

      const diff = await differ.diff(dbSchema)

      const dropTableChange = diff.changes.find(c => c.type === 'DROP_TABLE')

      expect(dropTableChange).toBeUndefined()
    })

    test('should drop table in unsafe mode', async () => {
      const entities = new Map() // No entities

      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: false,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('old_table', { tableName: 'old_table', schemaName: 'public' })

      const diff = await differ.diff(dbSchema)

      const dropTableChange = diff.changes.find(c => c.type === 'DROP_TABLE')

      expect(dropTableChange).toBeDefined()
      expect(dropTableChange?.tableName).toBe('old_table')
      expect(dropTableChange?.destructive).toBe(true)
    })
  })

  describe('No changes scenario', () => {
    test('should detect no changes when schema matches', async () => {
      const User = orm.entity('users', {
        name: orm.string(),
        email: orm.string(),
      }).build()

      const entities = new Map([[User.tableName, User]])
      const differ = new SchemaDiffer(entities, {
        autoMigrate: true,
        noInteraction: false,
        killIfUpdate: true,
        safeMigrations: true,
        migrationsPath: 'migrations',
        migrationsTable: '_migrations',
      })

      const dbSchema = createEmptySchema()

      dbSchema.tables.set('users', { tableName: 'users', schemaName: 'public' })
      dbSchema.columns.set('users', [
        createColumn('users', 'id', 'integer'),
        createColumn('users', 'name', 'text'),
        createColumn('users', 'email', 'text'),
      ])

      const diff = await differ.diff(dbSchema)

      expect(diff.hasChanges).toBe(false)
      expect(diff.changes.length).toBe(0)
    })
  })
})

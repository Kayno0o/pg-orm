import type { DatabaseSchema, SchemaChange } from '../src/migration/types'
import { describe, expect, test } from 'bun:test'
import { ORM } from '../src'
import { DependencySorter } from '../src/migration/dependency-sorter'

// ============================================================================
// Unit Tests - DependencySorter Direct Testing
// ============================================================================

describe('DependencySorter Unit Tests', () => {
  test('should group changes by type correctly', () => {
    const entities = new Map()
    const dbSchema: DatabaseSchema = {
      tables: new Map(),
      columns: new Map(),
      constraints: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    }

    const sorter = new DependencySorter(entities, dbSchema)

    const changes: SchemaChange[] = [
      { type: 'ADD_FOREIGN_KEY', tableName: 'posts', sql: '', description: 'Add FK' },
      { type: 'CREATE_TABLE', tableName: 'users', sql: '', description: 'Create users' },
      { type: 'ADD_COLUMN', tableName: 'posts', sql: '', description: 'Add column' },
      { type: 'DROP_FOREIGN_KEY', tableName: 'comments', sql: '', description: 'Drop FK' },
      { type: 'CREATE_TABLE', tableName: 'posts', sql: '', description: 'Create posts' },
    ]

    const sorted = sorter.sortChanges(changes)

    // Verify order: DROP_FK → CREATE_TABLE → ADD_COLUMN → ADD_FK
    expect(sorted[0]!.type).toBe('DROP_FOREIGN_KEY')
    expect(sorted[sorted.length - 1]!.type).toBe('ADD_FOREIGN_KEY')

    const createTableIndex = sorted.findIndex(c => c.type === 'CREATE_TABLE')
    const addFKIndex = sorted.findIndex(c => c.type === 'ADD_FOREIGN_KEY')

    expect(createTableIndex).toBeLessThan(addFKIndex)
  })

  test('should order CREATE_TABLE changes by dependencies', () => {
    // Define entities with dependency: Post → User
    const localOrm = new ORM()
    const User = localOrm.entity('test_order_users', f => ({
      name: f.string(),
    })).build()

    const Post = localOrm.entity('test_order_posts', f => ({
      title: f.string(),
      authorId: f.foreignKey('test_order_users'),
    })).build()

    const entities = new Map()

    entities.set('test_order_users', User)
    entities.set('test_order_posts', Post)

    const dbSchema: DatabaseSchema = {
      tables: new Map(),
      columns: new Map(),
      constraints: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    }

    const sorter = new DependencySorter(entities, dbSchema)

    const changes: SchemaChange[] = [
      { type: 'CREATE_TABLE', tableName: 'test_order_posts', sql: '', description: 'Create posts' },
      { type: 'CREATE_TABLE', tableName: 'test_order_users', sql: '', description: 'Create users' },
      {
        type: 'ADD_FOREIGN_KEY',
        tableName: 'test_order_posts',
        sql: 'ALTER TABLE test_order_posts ADD CONSTRAINT fk_posts_author_id FOREIGN KEY (author_id) REFERENCES test_order_users(id) ON DELETE NO ACTION ON UPDATE NO ACTION',
        description: 'Add FK',
      },
    ]

    const sorted = sorter.sortChanges(changes)

    // Users should be created before Posts
    const usersIndex = sorted.findIndex(c => c.tableName === 'test_order_users' && c.type === 'CREATE_TABLE')
    const postsIndex = sorted.findIndex(c => c.tableName === 'test_order_posts' && c.type === 'CREATE_TABLE')

    expect(usersIndex).toBeLessThan(postsIndex)

    // FK should be last
    expect(sorted[sorted.length - 1]!.type).toBe('ADD_FOREIGN_KEY')
  })

  test('should detect circular dependencies', () => {
    // Create circular dependency: A → B → C → A
    const localOrm = new ORM()
    const TableA = localOrm.entity('dep_circ_a', f => ({
      name: f.string(),
      cId: f.foreignKey('dep_circ_c'),
    })).build()

    const TableB = localOrm.entity('dep_circ_b', f => ({
      name: f.string(),
      aId: f.foreignKey('dep_circ_a'),
    })).build()

    const TableC = localOrm.entity('dep_circ_c', f => ({
      name: f.string(),
      bId: f.foreignKey('dep_circ_b'),
    })).build()

    const entities = new Map()

    entities.set('dep_circ_a', TableA)
    entities.set('dep_circ_b', TableB)
    entities.set('dep_circ_c', TableC)

    const dbSchema: DatabaseSchema = {
      tables: new Map(),
      columns: new Map(),
      constraints: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    }

    const sorter = new DependencySorter(entities, dbSchema)

    const changes: SchemaChange[] = [
      { type: 'CREATE_TABLE', tableName: 'dep_circ_a', sql: '', description: 'Create A' },
      { type: 'CREATE_TABLE', tableName: 'dep_circ_b', sql: '', description: 'Create B' },
      { type: 'CREATE_TABLE', tableName: 'dep_circ_c', sql: '', description: 'Create C' },
    ]

    expect(() => sorter.sortChanges(changes)).toThrow(/circular.*dependencies/i)
  })

  test('should detect type mismatch in foreign keys', () => {
    const localOrm = new ORM()
    const Parent = localOrm.entity('dep_type_parent', f => ({
      name: f.string(),
    })).build()

    const Child = localOrm.entity('dep_type_child', f => ({
      name: f.string(),
      parentId: f.foreignKey('dep_type_parent'), // DOUBLE PRECISION
    })).build()

    const entities = new Map()

    entities.set('dep_type_parent', Parent)
    entities.set('dep_type_child', Child)

    const dbSchema: DatabaseSchema = {
      tables: new Map(),
      columns: new Map(),
      constraints: new Map(),
      indexes: new Map(),
      foreignKeys: new Map(),
    }

    const sorter = new DependencySorter(entities, dbSchema)

    const changes: SchemaChange[] = [
      { type: 'CREATE_TABLE', tableName: 'dep_type_parent', sql: 'CREATE TABLE dep_type_parent (id SERIAL PRIMARY KEY, name TEXT NOT NULL)', description: 'Create parent' },
      { type: 'CREATE_TABLE', tableName: 'dep_type_child', sql: 'CREATE TABLE dep_type_child (id SERIAL PRIMARY KEY, name TEXT NOT NULL, parent_id DOUBLE PRECISION NOT NULL)', description: 'Create child' },
      {
        type: 'ADD_FOREIGN_KEY',
        tableName: 'dep_type_child',
        sql: 'ALTER TABLE dep_type_child ADD CONSTRAINT fk_child_parent_id FOREIGN KEY (parent_id) REFERENCES dep_type_parent(id) ON DELETE NO ACTION ON UPDATE NO ACTION',
        description: 'Add FK',
      },
    ]

    // Should throw validation error about type mismatch
    expect(() => sorter.sortChanges(changes)).toThrow(/type mismatch/i)
  })
})

// Note: Integration tests with real database require more complex setup
// The unit tests above validate the core dependency sorting logic
// End-to-end testing can be done manually or with example.ts

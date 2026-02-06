# Migration System Guide

This guide covers the complete migration system in @kaynooo/pg-orm, including auto-migrations, manual migrations, and best practices.

## Table of Contents

- [Overview](#overview)
- [Auto-Migration (Schema Diffing)](#auto-migration-schema-diffing)
- [Manual Migrations](#manual-migrations)
- [Configuration](#configuration)
- [Migration Commands](#migration-commands)
- [Migration Files](#migration-files)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Overview

The ORM provides two complementary migration strategies:

1. **Auto-Migration**: Automatically detects schema changes by comparing your entity definitions with the current database schema
2. **Manual Migrations**: File-based migrations for complex changes that require custom logic

Both systems work together seamlessly and track applied migrations in a `_migrations` table.

## Auto-Migration (Schema Diffing)

### How It Works

Auto-migration compares your TypeScript entity definitions with the current PostgreSQL schema and generates SQL to synchronize them.

```typescript
import { orm } from '@kaynooo/orm'

// Connect with auto-migration enabled (default)
await orm.connect({
  hostname: '127.0.0.1',
  database: 'mydb',

  // Auto-migration is ENABLED by default
  autoMigrate: true,

  // Prompt user before applying changes
  noInteraction: false,

  // Prevent accidental data loss
  safeMigrations: true,
})
```

### What Gets Detected

Auto-migration detects:

✅ **New tables** - Creates tables with all columns, constraints, indexes
✅ **New columns** - Adds columns to existing tables
✅ **Modified columns** - Changes data type, nullable, default value
✅ **New foreign keys** - Adds foreign key constraints
✅ **Modified foreign keys** - Updates ON DELETE/ON UPDATE rules
✅ **New unique constraints** - Adds UNIQUE constraints
✅ **Dropped foreign keys** - Removes foreign key constraints (if `safeMigrations: false`)
✅ **Dropped columns** - Removes columns (if `safeMigrations: false`)
✅ **Dropped tables** - Removes tables (if `safeMigrations: false`)
✅ **Dropped unique constraints** - Removes UNIQUE constraints (if `safeMigrations: false`)

### Example Flow

```typescript
// 1. Define your entity
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique(),
  age: f.number().nullable(),
})).build()

// 2. Connect to database
await orm.connect(DATABASE_URL)

// 3. Auto-migration detects changes and prompts:
//
// 🔍 Schema changes detected:
// ────────────────────────────────────────────────────────────
//   Create table users
//   Add UNIQUE constraint to users.email
// ────────────────────────────────────────────────────────────
//
// SQL to be executed:
// ────────────────────────────────────────────────────────────
//
// CREATE TABLE users (
//   id SERIAL PRIMARY KEY,
//   name TEXT NOT NULL,
//   email TEXT NOT NULL,
//   age INTEGER
// );
//
// ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
// ────────────────────────────────────────────────────────────
//
// Apply these changes? [y/n]:
```

### Configuration Options

```typescript
interface MigrationConfig {
  /**
   * Enable auto-migration at startup
   * @default true
   */
  autoMigrate?: boolean

  /**
   * Auto-approve migrations without user interaction
   * Useful for CI/CD environments
   * @default false
   */
  noInteraction?: boolean

  /**
   * Kill process if schema changes detected and user declines
   * Prevents running with stale schema
   * @default true
   */
  killIfUpdate?: boolean

  /**
   * Prevent destructive operations (DROP TABLE, DROP COLUMN)
   * When true, drops are detected but not auto-executed
   * @default true
   */
  safeMigrations?: boolean

  /**
   * Path to migration files directory
   * @default 'migrations'
   */
  migrationsPath?: string

  /**
   * Name of migrations tracking table
   * @default '_migrations'
   */
  migrationsTable?: string
}
```

### Production Configuration

```typescript
// Production: Auto-apply non-destructive changes
await orm.connect({
  hostname: process.env.DB_HOST,
  database: process.env.DB_NAME,

  autoMigrate: true,
  noInteraction: true,      // Don't prompt
  safeMigrations: true,     // Prevent data loss
})

// Development: Prompt for all changes
await orm.connect({
  hostname: '127.0.0.1',
  database: 'mydb_dev',

  autoMigrate: true,
  noInteraction: false,     // Prompt user
  safeMigrations: false,    // Allow drops
})

// CI/CD: Disable auto-migration, use manual migrations
await orm.connect({
  hostname: process.env.DB_HOST,
  database: process.env.DB_NAME,

  autoMigrate: false,       // Only run manual migrations
})
```

### Disabling Auto-Migration

If you prefer explicit control via manual migrations only:

```typescript
await orm.connect({
  hostname: '127.0.0.1',
  database: 'mydb',

  autoMigrate: false,  // Disable auto-migration
})
```

## Manual Migrations

Manual migrations are file-based TypeScript modules stored in the `migrations/` directory.

### Creating a Migration

```typescript
// CLI command (if you build one):
// bun run migration:create add_user_bio

// Or programmatically:
const migrator = orm.getMigrator()
const filePath = await migrator.create('add_user_bio')
console.log(`Created: ${filePath}`)
```

This generates:

```typescript
// migrations/20250128120000_add_user_bio.ts
import type { Migration } from '@kaynooo/orm'

export const migration: Migration = {
  name: '20250128120000_add_user_bio',

  async up(db) {
    // Write your migration here
    await db`
      ALTER TABLE users
      ADD COLUMN bio TEXT
    `
  },

  async down(db) {
    // Write your rollback here
    await db`
      ALTER TABLE users
      DROP COLUMN bio
    `
  },
}
```

### Running Migrations

```typescript
const migrator = orm.getMigrator()

// Run all pending migrations
await migrator.run()
// ✅ Executed 1 migration(s)

// Rollback last batch
await migrator.rollback()
// ✅ Rolled back 1 migration(s)

// Rollback all migrations
await migrator.reset()
// ✅ Rolled back all 5 migration(s)

// Check status
await migrator.status()
// 📊 Migration Status
// ────────────────────────────────────────────────────────────
// Total: 5
// Executed: 3
// Pending: 2
//
// ✅ Executed migrations:
//    20250128120000_create_users (batch 1)
//    20250128120100_add_user_bio (batch 2)
//    20250128120200_add_user_avatar (batch 2)
//
// ⏳ Pending migrations:
//    20250128120300_add_posts_table
//    20250128120400_add_comments_table
// ────────────────────────────────────────────────────────────
```

### Generating Migrations from Schema Diff

You can generate a manual migration file from the current schema diff:

```typescript
const migrator = orm.getMigrator()

// Generate migration from current schema changes
const filePath = await migrator.generate('sync_schema')
// ✅ Migration file created: migrations/20250128120500_sync_schema.ts
```

This creates a migration with auto-generated `up()` and `down()` statements based on detected schema changes.

## Configuration

### Database Connection with Migration Config

```typescript
await orm.connect({
  // Connection settings
  hostname: '127.0.0.1',
  port: 8532,
  database: 'mydb',
  username: 'postgres',
  password: 'secret',

  // Migration settings
  autoMigrate: true,
  noInteraction: false,
  safeMigrations: true,
  migrationsPath: 'db/migrations',  // Custom path
  migrationsTable: 'schema_versions', // Custom table name
})
```

### Accessing the Migrator

```typescript
const migrator = orm.getMigrator()

// Now you can call migration commands:
await migrator.status()
await migrator.run()
await migrator.rollback()
```

## Migration Commands

### `create(name: string)`

Create a new empty migration file.

```typescript
await migrator.create('add_user_preferences')
```

### `run()`

Run all pending migrations in order.

```typescript
await migrator.run()
```

### `rollback()`

Rollback the last batch of migrations.

```typescript
await migrator.rollback()
```

### `reset()`

Rollback ALL migrations.

```typescript
await migrator.reset()
```

### `status()`

Show migration status (executed vs pending).

```typescript
await migrator.status()
```

### `generate(name?: string)`

Generate a migration file from current schema diff.

```typescript
await migrator.generate('sync_user_schema')
```

### `clearAutoMigrations()`

Clear auto-migration tracking (useful for testing).

```typescript
await migrator.clearAutoMigrations()
```

## Migration Files

### File Naming Convention

```
{timestamp}_{name}.ts
```

Example:
```
20250128120000_create_users.ts
20250128120100_add_user_bio.ts
20250128120200_create_posts.ts
```

### Migration Structure

```typescript
import type { Migration } from '@kaynooo/orm'

export const migration: Migration = {
  name: '20250128120000_create_users',

  async up(db) {
    // Forward migration
    await db`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `
  },

  async down(db) {
    // Rollback migration
    await db`DROP TABLE users`
  },
}
```

### Complex Migrations

```typescript
export const migration: Migration = {
  name: '20250128120500_migrate_user_data',

  async up(db) {
    // Add new column
    await db`
      ALTER TABLE users
      ADD COLUMN full_name TEXT
    `

    // Migrate data
    await db`
      UPDATE users
      SET full_name = first_name || ' ' || last_name
      WHERE full_name IS NULL
    `

    // Drop old columns
    await db`
      ALTER TABLE users
      DROP COLUMN first_name,
      DROP COLUMN last_name
    `

    // Make required
    await db`
      ALTER TABLE users
      ALTER COLUMN full_name SET NOT NULL
    `
  },

  async down(db) {
    // Add old columns back
    await db`
      ALTER TABLE users
      ADD COLUMN first_name TEXT,
      ADD COLUMN last_name TEXT
    `

    // Migrate data back (best effort)
    await db`
      UPDATE users
      SET
        first_name = SPLIT_PART(full_name, ' ', 1),
        last_name = SPLIT_PART(full_name, ' ', 2)
    `

    // Drop new column
    await db`
      ALTER TABLE users
      DROP COLUMN full_name
    `
  },
}
```

## Best Practices

### 1. Always Write Rollbacks

Every migration should have a `down()` method that reverses the `up()` changes.

```typescript
// ✅ GOOD: Complete rollback
async down(db) {
  await db`DROP TABLE posts`
}

// ❌ BAD: Empty rollback
async down(db) {
  // TODO: Implement rollback
}
```

### 2. Test Migrations

Test both `up` and `down` before deploying:

```bash
bun run migrate       # Apply migration
bun run rollback      # Test rollback
bun run migrate       # Apply again
```

### 3. Keep Migrations Small

One logical change per migration file:

```typescript
// ✅ GOOD: Single responsibility
20250128120000_add_user_bio.ts
20250128120100_add_user_avatar.ts

// ❌ BAD: Multiple unrelated changes
20250128120000_add_all_user_fields.ts
```

### 4. Use Transactions

Migrations run in transactions by default. Keep each migration atomic:

```typescript
// ✅ GOOD: Single transaction (automatic)
async up(db) {
  await db`ALTER TABLE users ADD COLUMN bio TEXT`
  await db`UPDATE users SET bio = 'Default bio'`
}

// ❌ BAD: Mixing transaction and non-transaction operations
async up(db) {
  await db`ALTER TABLE users ADD COLUMN bio TEXT`
  await someExternalAPI() // Not part of transaction!
}
```

### 5. Never Modify Executed Migrations

Once a migration is deployed, never change it. Create a new migration instead:

```typescript
// ❌ BAD: Modifying executed migration
// migrations/20250128120000_create_users.ts
async up(db) {
  await db`CREATE TABLE users (...)`
  await db`ALTER TABLE users ADD COLUMN new_field TEXT` // Added later
}

// ✅ GOOD: New migration
// migrations/20250128120100_add_user_new_field.ts
async up(db) {
  await db`ALTER TABLE users ADD COLUMN new_field TEXT`
}
```

### 6. Use Schema Diff for Inspiration

Generate a migration from schema diff to get correct SQL:

```typescript
// 1. Update your entity definition
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique(),
  bio: f.string().nullable(), // Added
})).build()

// 2. Generate migration
await migrator.generate('add_user_bio')

// 3. Review generated SQL and customize if needed
```

### 7. Handle Data Migration Carefully

For data transformations, consider:

```typescript
async up(db) {
  // 1. Add new column as nullable
  await db`ALTER TABLE users ADD COLUMN email_verified BOOLEAN`

  // 2. Populate with default
  await db`UPDATE users SET email_verified = false WHERE email_verified IS NULL`

  // 3. Make NOT NULL
  await db`ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL`

  // 4. Add default for future rows
  await db`ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false`
}
```

### 8. Safe Migration Settings

For production, use safe defaults:

```typescript
await orm.connect({
  hostname: process.env.DB_HOST,
  database: process.env.DB_NAME,

  autoMigrate: true,
  noInteraction: true,
  safeMigrations: true,  // IMPORTANT: Prevents drops
  killIfUpdate: true,    // IMPORTANT: Fail if unexpected changes
})
```

### 9. Version Control

Always commit migration files:

```bash
git add migrations/20250128120000_add_user_bio.ts
git commit -m "Add user bio field migration"
```

### 10. Deployment Strategy

```typescript
// Option 1: Auto-migration in production (safe changes only)
await orm.connect({
  ...dbConfig,
  autoMigrate: true,
  noInteraction: true,
  safeMigrations: true,
})

// Option 2: Manual migrations only (recommended for production)
await orm.connect({
  ...dbConfig,
  autoMigrate: false,  // Disable auto-migration
})
await migrator.run()  // Run pending migrations
```

## Troubleshooting

### Migration Already Applied Error

**Problem**: Migration runs but shows as pending

**Solution**: Check migration name matches file name exactly

```typescript
// File: 20250128120000_create_users.ts
export const migration: Migration = {
  name: '20250128120000_create_users', // Must match file name without .ts
  // ...
}
```

### Schema Diff Not Detecting Changes

**Problem**: Entity changes not detected by auto-migration

**Solutions**:
1. Ensure entity is registered: `orm.entity(...).build()`
2. Check column name mapping (camelCase → snake_case)
3. Verify database connection is active
4. Clear auto-migration tracking: `await migrator.clearAutoMigrations()`

### Migration Fails Midway

**Problem**: Migration partially applied

**Solution**: Migrations run in transactions and auto-rollback on error. Check the error message and fix the SQL.

```typescript
// Failed migration is NOT recorded in _migrations table
// Safe to fix and re-run
```

### Rollback Data Loss

**Problem**: Rollback loses data

**Solution**: Some operations can't be reversed (DROP TABLE). Always backup before rolling back in production.

```typescript
// Before rollback in production:
pg_dump mydb > backup_$(date +%Y%m%d_%H%M%S).sql

// Then rollback:
await migrator.rollback()
```

### Auto-Migration in CI/CD

**Problem**: CI fails due to schema changes prompt

**Solution**: Use `noInteraction: true` or disable auto-migration

```typescript
// CI Environment
await orm.connect({
  ...dbConfig,
  autoMigrate: true,
  noInteraction: true,  // Don't prompt
})

// Or disable entirely and use manual migrations
await orm.connect({
  ...dbConfig,
  autoMigrate: false,
})
```

### Circular Foreign Key Dependencies

**Problem**: Can't create tables due to circular foreign keys

**Solution**: Create tables first, add foreign keys after

```typescript
async up(db) {
  // 1. Create tables without foreign keys
  await db`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`
  await db`CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT)`

  // 2. Add foreign keys
  await db`ALTER TABLE posts ADD COLUMN author_id INTEGER REFERENCES users(id)`
  await db`ALTER TABLE users ADD COLUMN pinned_post_id INTEGER REFERENCES posts(id)`
}
```

## Migration Tracking

Migrations are tracked in the `_migrations` table:

```sql
CREATE TABLE _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  batch INTEGER NOT NULL
)
```

**Batch System**: Migrations run together have the same batch number, allowing group rollback.

```
| id | name                        | executed_at         | batch |
|----|-----------------------------|---------------------|-------|
| 1  | 20250128120000_create_users | 2025-01-28 12:00:00 | 1     |
| 2  | 20250128120100_add_user_bio | 2025-01-28 12:05:00 | 2     |
| 3  | 20250128120200_add_posts    | 2025-01-28 12:05:00 | 2     |
| 4  | auto_abc123                 | 2025-01-28 12:10:00 | 3     |
```

Auto-migrations are prefixed with `auto_` and include a hash of the changes.

## Additional Resources

- [Schema Differ Implementation](../src/migration/schema-differ.ts)
- [Migration Runner](../src/migration/runner.ts)
- [Migration Generator](../src/migration/generator.ts)
- [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [Database Migration Best Practices](https://www.prisma.io/dataguide/types/relational/migration-strategies)

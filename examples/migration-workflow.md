# Migration Workflow Example

This document demonstrates a complete migration workflow from development to production.

## Scenario

You're building a blog platform and need to add user profiles with bio and avatar fields.

## Development Workflow

### 1. Update Your Entity Definition

```typescript
// src/entities/user.ts
import { orm, timestamps } from '@kaynooo/pg-orm'

export const User = orm
  .entity('users', {
    name: orm.string(),
    email: orm.string().unique(),

    // NEW: Add bio and avatar fields
    bio: orm.string().nullable(),
    avatarUrl: orm.string().nullable(),
  })
  .use(timestamps())
  .build()
```

### 2. Run Your App in Development

```bash
# Development mode with auto-migration
DATABASE_URL=postgres://localhost/blog_dev bun run dev
```

**What happens:**
```
🔍 Schema changes detected:
────────────────────────────────────────────────────────────
  Add column users.bio
  Add column users.avatar_url
────────────────────────────────────────────────────────────

SQL to be executed:
────────────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN bio TEXT;

ALTER TABLE users ADD COLUMN avatar_url TEXT;
────────────────────────────────────────────────────────────

Apply these changes? [y/n]:
```

Type `y` to apply the changes. Your local database is now updated!

### 3. Generate a Migration File (Optional)

For production deployment, you'll want a migration file:

```bash
# Generate migration from current schema diff
bun examples/cli-migrations.ts generate add_user_profile_fields
```

**Generated file:** `migrations/20250128120000_add_user_profile_fields.ts`

```typescript
import type { Migration } from '@kaynooo/orm'

// Auto-generated migration
// Changes detected:
//   - Add column users.bio
//   - Add column users.avatar_url

export const migration: Migration = {
  name: '20250128120000_add_user_profile_fields',

  async up(db) {
    await db`ALTER TABLE users ADD COLUMN bio TEXT`

    await db`ALTER TABLE users ADD COLUMN avatar_url TEXT`
  },

  async down(db) {
    await db`ALTER TABLE users DROP COLUMN avatar_url`

    await db`ALTER TABLE users DROP COLUMN bio`
  },
}
```

### 4. Test the Migration

```bash
# Run migration
bun examples/cli-migrations.ts run

# Test rollback
bun examples/cli-migrations.ts rollback

# Run again
bun examples/cli-migrations.ts run
```

### 5. Commit to Git

```bash
git add migrations/20250128120000_add_user_profile_fields.ts
git add src/entities/user.ts
git commit -m "Add user profile fields (bio, avatar)"
git push
```

## Staging Deployment

### Option A: Auto-Migration (Recommended for Staging)

```bash
# .env.staging
DATABASE_URL=postgres://staging-db/blog
AUTO_MIGRATE=true
NO_INTERACTION=true  # Auto-apply safe changes
SAFE_MIGRATIONS=true # Prevent destructive operations
```

```typescript
// src/index.ts
await orm.connect({
  ...parseConnectionString(process.env.DATABASE_URL!),
  autoMigrate: process.env.AUTO_MIGRATE === 'true',
  noInteraction: process.env.NO_INTERACTION === 'true',
  safeMigrations: process.env.SAFE_MIGRATIONS === 'true',
})
```

Deploy and the schema will be automatically updated on startup!

### Option B: Manual Migrations

```bash
# Run migrations before starting the app
bun examples/cli-migrations.ts run

# Then start the app
bun start
```

## Production Deployment

### Recommended: Manual Migrations

```dockerfile
# Dockerfile
FROM oven/bun:latest

WORKDIR /app
COPY . .
RUN bun install

# Run migrations before starting the app
CMD bun examples/cli-migrations.ts run && bun start
```

Or use a deployment script:

```bash
#!/bin/bash
# deploy.sh

set -e

echo "🔄 Running database migrations..."
DATABASE_URL=$PROD_DATABASE_URL bun examples/cli-migrations.ts run

echo "🚀 Starting application..."
DATABASE_URL=$PROD_DATABASE_URL bun start
```

### Production Config

```bash
# .env.production
DATABASE_URL=postgres://prod-db/blog
AUTO_MIGRATE=false  # Disable auto-migration in production
```

```typescript
// Production: Only run manual migrations
await orm.connect({
  ...parseConnectionString(process.env.DATABASE_URL!),
  autoMigrate: false, // Always false in production
})
```

## Advanced: Blue-Green Deployment

For zero-downtime deployments:

### 1. Make Changes Backwards Compatible

```typescript
// ✅ GOOD: Add nullable fields first
export const User = orm
  .entity('users', {
    name: orm.string(),
    email: orm.string().unique(),
    bio: orm.string().nullable(),      // Nullable, safe to add
    avatarUrl: orm.string().nullable(), // Nullable, safe to add
  })
  .use(timestamps())
  .build()
```

### 2. Deploy in Phases

**Phase 1: Add columns (deploy blue)**
```bash
# Deploy new version with new columns
# Old version still works (new columns are nullable)
bun examples/cli-migrations.ts run
```

**Phase 2: Switch traffic (blue → green)**
```bash
# Switch load balancer to new version
# Both versions can coexist
```

**Phase 3: Clean up old version**
```bash
# After verifying green is stable, shut down blue
```

## Handling Data Migrations

For complex data transformations:

### Example: Splitting Full Name

```typescript
// Migration: Split full_name into first_name and last_name
export const migration: Migration = {
  name: '20250128120100_split_user_names',

  async up(db) {
    // 1. Add new columns (nullable)
    await db`
      ALTER TABLE users
      ADD COLUMN first_name TEXT,
      ADD COLUMN last_name TEXT
    `

    // 2. Migrate data
    await db`
      UPDATE users
      SET
        first_name = SPLIT_PART(full_name, ' ', 1),
        last_name = SPLIT_PART(full_name, ' ', 2)
      WHERE first_name IS NULL
    `

    // 3. Make columns NOT NULL
    await db`
      ALTER TABLE users
      ALTER COLUMN first_name SET NOT NULL,
      ALTER COLUMN last_name SET NOT NULL
    `

    // 4. Drop old column
    await db`
      ALTER TABLE users
      DROP COLUMN full_name
    `
  },

  async down(db) {
    // Reverse the migration
    await db`
      ALTER TABLE users
      ADD COLUMN full_name TEXT
    `

    await db`
      UPDATE users
      SET full_name = first_name || ' ' || last_name
    `

    await db`
      ALTER TABLE users
      ALTER COLUMN full_name SET NOT NULL,
      DROP COLUMN first_name,
      DROP COLUMN last_name
    `
  },
}
```

## Rollback Strategy

### If Something Goes Wrong

```bash
# Rollback the last migration
bun examples/cli-migrations.ts rollback

# Check status
bun examples/cli-migrations.ts status

# Verify application works
bun start
```

### Database Backups

Always backup before running migrations in production:

```bash
#!/bin/bash
# backup-and-migrate.sh

set -e

# Backup database
echo "📦 Creating backup..."
pg_dump $DATABASE_URL > backups/backup_$(date +%Y%m%d_%H%M%S).sql

# Run migrations
echo "🔄 Running migrations..."
bun examples/cli-migrations.ts run

echo "✅ Migration complete"
```

## CI/CD Pipeline Example

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - uses: oven-sh/setup-bun@v1

      - name: Install dependencies
        run: bun install

      - name: Run tests
        run: bun test

      - name: Backup database
        run: |
          pg_dump ${{ secrets.DATABASE_URL }} > backup.sql

      - name: Run migrations
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: bun examples/cli-migrations.ts run

      - name: Deploy application
        run: |
          # Your deployment command here
          ./deploy.sh
```

## Best Practices

### ✅ DO

- Always test migrations locally first
- Backup production database before migrations
- Make migrations backwards compatible when possible
- Use transactions for multi-step migrations
- Review generated SQL before applying
- Keep migrations small and focused

### ❌ DON'T

- Don't modify executed migrations
- Don't delete migration files that have been run
- Don't skip testing rollbacks
- Don't run migrations directly in production without backup
- Don't use auto-migration in production (use manual migrations)

## Troubleshooting

### Migration Fails

```bash
# Check what went wrong
bun examples/cli-migrations.ts status

# The failed migration is NOT recorded
# Fix the migration file and run again
bun examples/cli-migrations.ts run
```

### Need to Fix Production

```bash
# Option 1: Rollback and fix
bun examples/cli-migrations.ts rollback
# Fix the migration file
bun examples/cli-migrations.ts run

# Option 2: Create a new migration to fix
bun examples/cli-migrations.ts create fix_user_fields
# Edit the migration
bun examples/cli-migrations.ts run
```

### Schema Drift

If your database schema doesn't match your entities:

```bash
# Generate a migration to sync
bun examples/cli-migrations.ts generate sync_schema

# Review the generated migration
# Apply it
bun examples/cli-migrations.ts run
```

## Summary

This workflow ensures:
- ✅ Safe schema changes
- ✅ Repeatable deployments
- ✅ Easy rollbacks
- ✅ Zero-downtime updates (with blue-green)
- ✅ Version control for schema changes

Choose the approach that fits your team's needs and risk tolerance!

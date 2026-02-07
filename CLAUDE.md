# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Type-safe ORM for **Bun + PostgreSQL** (`@kaynooo/pg-orm`). Uses Bun's native SQL driver, builder pattern APIs, and advanced TypeScript generics for type inference. ES modules throughout.

## Commands

```bash
# Database (PostgreSQL 16 via Docker)
bun run db:up          # Start PostgreSQL container (port 8532)
bun run db:down        # Stop container
bun run db:reset       # Reset database (down -v && up -d)

# Build
bun run build          # Clean build → dist/ (bun build + tsc declarations)

# Type checking
bun run check          # tsc --noEmit --strict

# Lint
bun run lint:fix       # ESLint with auto-fix

# Tests (requires running PostgreSQL container)
bun test               # Run all tests
bun test tests/query.test.ts          # Run a single test file
bun test --test-name-pattern "create"  # Run tests matching pattern
bun run test:coverage  # Generate HTML coverage report

# Code quality
bun run circular       # Detect circular dependencies (madge)
bun run duplicates     # Detect duplicate code (jscpd)
bun run unused         # Detect unused exports (knip)
```

**Test database connection:** `postgres://test:test@127.0.0.1:8532/orm_test`

## Architecture

### Core Flow

`ORM` → defines `Entity` (via builder) → creates `Repository` → builds `Query`

1. **ORM** (`src/orm.ts`) — Central orchestrator. Manages connections, entity registration, repository caching (WeakMap), transactions, and lazy-loaded migration system.

2. **EntityBuilder** (`src/entity.ts`) — Fluent builder for defining table schemas. Supports lifecycle hooks (beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete, afterDelete), trait composition via `.use()`, unique constraints, and named query scopes. `.build()` freezes and returns the definition.

3. **Field builders** (`src/field.ts`) — Type-safe field definitions. Each type (string, number, boolean, uuid, timestamp, date, enum, json, blob, array, foreignKey) returns a builder with chainable constraints (`.nullable()`, `.default()`, `.unique()`, `.validate()`, `.column()`). The field type determines the inferred TypeScript type.

4. **Repository** (`src/repository.ts`) — CRUD operations (find, findById, create, update, delete) with validation, hook execution, bulk operations, and optional caching (CacheAdapter interface).

5. **QueryBuilder** (`src/query.ts`, largest file) — SQL construction with type-safe where conditions, joins (INNER/LEFT/RIGHT/FULL), aggregations (COUNT/SUM/AVG/MIN/MAX), GROUP BY/HAVING, pagination (limit/offset/cursor), field projection, and scope application.

### Schema & Mapping Layer

- **SchemaMetadata** (`src/schema-metadata.ts`) — Centralized field↔column name mapping (handles JS camelCase ↔ SQL snake_case). Provides lookup methods used throughout the ORM.
- **EntityMapper** (`src/mapper.ts`) — Compiles specialized row-to-entity transform functions at runtime (via `new Function`) for performance. Falls back to interpreted mapper in CSP-restricted environments. Handles array parsing, date conversion, and null values.

### Migration System (`src/migration/`)

Automatic schema migrations with diffing:
- **Migrator** — Orchestrates migration lifecycle, auto-migration on connect
- **SchemaInspector** — Introspects current PostgreSQL schema (tables, columns, constraints, indexes)
- **SchemaDiffer** (`schema-differ.ts`, 2nd largest file) — Compares entity definitions against database, detects table/column/constraint changes, marks destructive operations
- **DependencySorter** — Topological sort for correct migration operation ordering (create tables → add columns → modify → add FKs → drop FKs → drop columns → drop tables)
- **MigrationRunner** — Executes migration files, tracks in `_migrations` table with batch grouping

### Traits System (`src/traits.ts`)

Composable entity mixins via `TraitBuilder`. Pre-built traits: `timestamps()`, `softDelete()`, `paranoid()`, `sluggable()`, `sortable()`, `publishable()`, `uuidPrimary()`, `versionable()`. Traits can add fields, methods, and hooks.

### Type Inference (`src/types.ts`)

Key inferred types: `InferEntity<T>` (runtime entity), `InferCreateData<T>` (create params), `InferUpdateData<T>` (update params), `InferProjection<T, Fields>` (selected fields), `WhereCondition<T>` (typed WHERE). These use conditional types to derive correct shapes from entity definitions.

### Security

- **SQL injection prevention** (`src/sql-utils.ts`) — Identifier validation (pattern, length, reserved words), quoting. All user-facing identifiers are validated before SQL construction.
- **Validation** (`src/validation.ts`) — Schema-driven validation before DB operations with custom validator support.
- **Error mapping** (`src/errors.ts`, `src/utils/error-mapper.ts`) — PostgreSQL errors mapped to domain-specific errors (UniqueConstraintViolation, ForeignKeyConstraintViolation, etc.).

### Other Components

- **Database** (`src/db.ts`) — Connection wrapper around Bun SQL with pool config, SSL, schema selection, query limits
- **Cache** (`src/cache/`) — Pluggable caching with `InMemoryCache` implementation (TTL-based with background cleanup)
- **Seeder** (`src/seeder.ts`) — Database seeding framework with group filtering
- **Factory** (`src/factory.ts`) — Test data factories via `defineFactory()`
- **Logger** (`src/logger.ts`) — Query logging with operation extraction
- **CLI** (`src/cli.ts`) — Migration and seeding commands

## Key Conventions

- All source in `src/`, tests in `tests/`, examples in `examples/`
- Builder pattern with immutable cloning (`.clone()`) — builders return new instances on mutation
- Entity definitions are frozen after `.build()`
- Repositories are cached per entity definition in ORM via WeakMap
- Database is a global singleton (`src/db.ts`)
- snake_case for SQL columns, camelCase for JS fields (automatic conversion via SchemaMetadata)

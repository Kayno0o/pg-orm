# ORM v2 Architecture Guide

## High-Level Overview

**@kaynooo/orm** is a lightweight, type-safe Object-Relational Mapping (ORM) library built specifically for Bun's SQL API with PostgreSQL support. It provides decorator-based entity definitions and a repository pattern for clean database abstraction.

**Project Type:** Database ORM Library
**Target Runtime:** Bun
**Database:** PostgreSQL (v2 exclusively - moved away from SQLite support)
**Language:** TypeScript
**Distribution:** npm/bun package (@kaynooo/orm)

## Key Differentiators

- **Bun-Native:** Leverages Bun's native SQL API with tagged template literals for SQL injection protection
- **Fully Async:** All operations return Promises - no synchronous database calls
- **PostgreSQL-First:** Optimized for PostgreSQL-specific features (arrays, RETURNING clauses, etc.)
- **Type-Safe:** Full TypeScript support with automatic type inference
- **Decorator-Based:** Clean entity definition syntax using TypeScript decorators
- **Minimal Dependencies:** Only depends on @kaynooo/utils and bun-types

## Directory Structure

```
/home/kaynooo/Workspace/orm/v2/
├── src/                          # Main source code
│   ├── index.ts                  # Public API exports
│   ├── entity.ts                 # AbstractEntity base class
│   ├── decorators.ts             # @Entity, @Column, and specialized decorators
│   ├── db.ts                     # Database connection management and initialization
│   ├── repository.ts             # AbstractRepository CRUD operations
│   ├── queryBuilder.ts           # QueryBuilder for complex SQL queries
│   ├── metadata.ts               # Decorator metadata management and reflection
│   └── types.ts                  # TypeScript type definitions
│
├── test/                         # Test suite
│   ├── entities/                 # Test entity definitions
│   │   ├── Tag.ts               # Tag test entity
│   │   └── User.ts              # User test entity with foreign key
│   ├── setup.ts                 # Database setup/teardown for tests
│   ├── entity.test.ts           # Entity functionality tests
│   ├── repository.test.ts       # Repository CRUD tests
│   └── queryBuilder.test.ts     # QueryBuilder tests
│
├── node_modules/                # Dependencies
├── .env                         # Environment configuration (DATABASE_URL)
├── .env.example                 # Example environment file
├── bun.lock                     # Bun lock file
├── docker-compose.yml           # PostgreSQL test database setup
├── package.json                 # Project metadata and scripts
├── tsconfig.json                # TypeScript configuration
├── eslint.config.js             # ESLint configuration
├── README.md                    # User-facing documentation
├── IMPROVEMENT_PLAN.md          # Development roadmap
├── bun.sql.md                   # Bun SQL API reference documentation
└── example.ts                   # Example usage demonstrating the API
```

## Source Code Organization

### Core Modules

**src/index.ts** - Public API Surface
- Exports all public decorators, classes, and functions
- Main entry point for library consumers
- Exports: Entity, Column (and specialized variants), AbstractEntity, AbstractRepository, database functions, QueryBuilder, types

**src/entity.ts** - Base Entity Class
- `AbstractEntity` - Provides `id` primary key field and `save()` method
- Implements `Identifiable` interface
- `save()` is a convenience method that calls the repository's `persist()` internally

**src/decorators.ts** - Entity & Column Decorators
- `@Entity(tableName, options?)` - Marks a class as a database entity
  - Supports composite unique constraints via options.unique
- `@Column(type, options?)` - Marks properties as database columns
  - Supported column types: bool, int, float, text, blob, json, jsonb, uuid, timestamp, array, enum
  - Options: nullable, unique, primary, default, name, reference (foreign key), autoUpdate
- Convenience decorators:
  - `@JsonColumn()` - Maps to jsonb
  - `@UuidColumn()` - Maps to uuid
  - `@ArrayColumn(arrayType)` - Maps to PostgreSQL arrays
  - `@EnumColumn(enumValues)` - Type-safe enum support
  - `@TimestampColumn()` - Generic timestamp
  - `@CreatedAt()` - Auto-managed creation timestamp
  - `@UpdatedAt()` - Auto-managed update timestamp

**src/db.ts** - Database Connection Management
- `initDB()` - Initializes database connection and registers repositories
  - Accepts connection string or configuration object
  - Supports connection pooling, TLS, timeouts, lifecycle callbacks
- `getDB()` - Returns the global SQL instance for direct queries
- `getRepository()` - Retrieves a registered repository by entity class
- `closeDB()` - Closes database connection and clears registry
- `transaction()` - Executes code within a database transaction
- `sql` - Proxy to the global database instance

**src/repository.ts** - CRUD Operations
- `AbstractRepository<T>` - Base repository class for all entities
- Methods:
  - `create(data)` - Insert a new entity
  - `find(id)` - Find entity by primary key
  - `findAll()` - Get all entities
  - `findAllBy(options)` - Find with where, order, notNull filters
  - `findOneBy(options)` - Find first matching entity
  - `update(id, data)` - Update an entity
  - `delete(id)` - Delete an entity
  - `persist(data)` - Insert or update based on id presence
  - `transaction()` - Execute operations within a transaction
  - `withTx()` - Create a transactional repository instance
- Features:
  - Metadata caching for performance
  - Transaction context support
  - Support for array-based IN clauses (PostgreSQL arrays)

**src/queryBuilder.ts** - Complex Query Building
- `QueryBuilder<T>` - Fluent API for building SQL queries
- Methods:
  - `select(...fields)` - SELECT clause
  - `join(table, alias, condition)` - INNER JOIN
  - `leftJoin(table, alias, condition)` - LEFT JOIN
  - `where(fragment)` - WHERE clause (chainable)
  - `groupBy(...fields)` - GROUP BY
  - `having(fragment)` - HAVING clause
  - `order(field, direction)` - ORDER BY
  - `limit(n)`, `offset(n)` - Pagination
  - `findAll()`, `findOne()`, `count()` - Execution methods
  - `build()` - Get [query, params] tuple for manual execution

**src/metadata.ts** - Decorator Metadata Management
- Reflection and metadata storage for entities and columns
- `getEntityMetadata()` - Retrieve entity metadata
- `getColumnMetadata()` - Get all columns for an entity
- `getColumnMetadataByKey()` - Get specific column metadata
- `setEntityMetadata()`, `setColumnMetadata()` - Store metadata
- `mapColumnTypeToPostgres()` - Convert column types to PostgreSQL DDL
- `getAllEntities()` - Get all registered entities

**src/types.ts** - Type System
- `Identifiable` - Interface for entities with id field
- `SQLQueryBindings` - Valid SQL parameter types
- `DBField` - Column definition metadata
- `PartialRecord<K, T>` - Partial record helper
- `QueryOptions<T>` - Options for find operations
- `TransactionContext` - Type for transaction SQL instance

## Technology Stack

### Runtime & Build
- **Bun** - JavaScript runtime, test runner, and bundler
- **TypeScript** - Language for type safety
- **ESNext** - Target module system

### Key Dependencies
- **bun-types** - Type definitions for Bun API
- **@kaynooo/utils** - Utility functions
- **@kaynooo/eslint** - ESLint configuration

### Database
- **Bun's SQL API** - Native SQL support with prepared statements, connection pooling
- **PostgreSQL** - Production database

### Development & Testing
- **Docker Compose** - PostgreSQL test environment (postgres:16-alpine)
- **bun:test** - Native test runner (no external test framework)
- **ESLint** - Code linting

## Build & Script Configuration

### package.json Scripts
```json
{
  "build": "bun build ./src/index.ts --outdir ./dist --target bun",
  "dev": "bun --watch ./src/index.ts",
  "example": "bun run example.ts",
  "test": "bun test",
  "test:watch": "bun test --watch",
  "check": "tsc --noEmit --strict",
  "lint:fix": "bunx eslint . --fix",
  "db:up": "docker-compose up -d",
  "db:down": "docker-compose down",
  "db:reset": "docker-compose down -v && docker-compose up -d"
}
```

### Build Artifacts
- **dist/** - Output directory (not in repo - generated by `bun build`)
  - dist/index.js - Built JavaScript
  - dist/index.d.ts - TypeScript type definitions

### TypeScript Configuration (tsconfig.json)
- **Target:** ESNext
- **Module:** ESNext with bundler resolution
- **Strict Mode:** Enabled
- **Decorators:** Experimental decorators enabled
- **Declaration:** True (generates .d.ts files)
- **No Emit:** For type checking only (build handles compilation)

## Configuration Files

### .env / .env.example
```
DATABASE_URL=postgres://test:test@localhost:5432/orm_test
```
Used for database connection during testing and development.

### docker-compose.yml
- PostgreSQL 16 Alpine image
- Container: orm-v2-postgres
- Port: 5432 (local)
- Health checks enabled
- Persistent volume: postgres_data

### eslint.config.js
- Uses @kaynooo/eslint TypeScript preset
- Ignores markdown files

## Testing Architecture

### Test Setup (test/setup.ts)
- `setupTestDB()` - Initialize ORM with test repositories
- `teardownTestDB()` - Close database connection
- `createTables()` - Create tag and user tables for tests
- `cleanTables()` - Truncate tables and reset sequences

### Test Entities
- **Tag** - Simple entity with name and description
- **User** - Entity with foreign key reference to Tag

### Test Files
- **entity.test.ts** - Entity persistence and initialization
- **repository.test.ts** - CRUD operations and query options
- **queryBuilder.test.ts** - Complex query building and execution

## Example Usage Pattern

The `example.ts` file demonstrates:
1. Entity definition with decorators
2. Custom repository extension
3. Database initialization
4. CRUD operations
5. Query builder usage
6. Transaction handling

## Key Architectural Principles

1. **Metadata-Driven:** Decorators store metadata that's reflected at runtime
2. **Repository Pattern:** Each entity has a repository for data access
3. **Type Safety First:** Full TypeScript support with type inference
4. **Connection Management:** Centralized database initialization and lifecycle
5. **Prepared Statements:** All queries use Bun's safe SQL composition
6. **Transaction Support:** First-class transaction support via Bun's SQL.begin()
7. **Array Support:** Leverages PostgreSQL arrays for efficient IN clauses
8. **Lazy Evaluation:** Query building is lazy - execution happens at .findAll/.findOne/etc

## Version 2 Differences from v1

- PostgreSQL only (no SQLite support)
- Fully asynchronous (all methods return Promises)
- No built-in migrations (manual schema management)
- Uses Bun SQL API instead of better-sqlite3
- Enhanced performance with PostgreSQL-specific features
- New specialized decorators (@CreatedAt, @UpdatedAt, @UuidColumn, etc.)

## Package Distribution

- **Type:** ES Module (type: "module")
- **Exports:** 
  - `.` → TypeScript types (dist/index.d.ts) and JavaScript (dist/index.js)
- **Main:** dist/index.js
- **Types:** dist/index.d.ts
- **Peer Dependency:** bun-types (latest)

## Development Workflow

1. Modify source in `src/`
2. Run `bun run check` to validate TypeScript
3. Run `bun run test:watch` for test-driven development
4. Run `bun run db:up` to start PostgreSQL
5. Run `bun run lint:fix` to format code
6. Run `bun run build` to create distribution

## Claude Code Token Optimization

### Context Window Strategy

This project is designed for efficient Claude Code usage with compact, focused files. The entire `src/` directory is lean (~1500 lines total) and can fit comfortably within Claude's context window.

### File Reading Guidelines

**ALWAYS READ FIRST:**
- `src/` - Core implementation files (read all when working on features)
- `test/` - Test files (read relevant test when modifying features)
- `example.ts` - Usage examples for understanding API patterns

**READ SELECTIVELY:**
- `test/entities/` - Only when working on entity-related features
- `test/setup.ts` - Only when modifying test infrastructure
- Specific test files based on the feature being modified

**AVOID READING (unless explicitly requested):**
- `node_modules/` - Never read unless debugging dependency issues
- `dist/` - Generated build artifacts, not source code
- `.env` - Environment config, not code
- `docker-compose.yml` - Infrastructure config
- `bun.lock` - Dependency lock file
- `README.md`, `IMPROVEMENT_PLAN.md` - Documentation files
- `bun.sql.md` - Reference documentation (only if needed)

### Optimization Best Practices

**Compact File Structure:**
- This project maintains lean, single-purpose files
- Each `src/` file has a clear responsibility
- Average file size: ~200-300 lines
- No file exceeds 500 lines

**Batch Related Changes:**
- When modifying features, batch all related edits together
- Example: When updating a decorator, edit both `decorators.ts` and relevant tests in one go
- Minimize back-and-forth file reads

**Explicit Task Instructions:**
- Provide numbered steps for complex changes
- Specify exactly which files need modification
- Example: "1. Update AbstractRepository in src/repository.ts, 2. Add test in test/repository.test.ts, 3. Update types in src/types.ts"

**Avoid Unnecessary Context:**
- Don't read all test files when working on a single feature
- Don't read configuration files unless modifying build/test setup
- Don't explore documentation files during code changes

### Directory Boundaries

**Core Implementation (Primary Context):**
```
src/
├── index.ts          (~50 lines)
├── entity.ts         (~30 lines)
├── decorators.ts     (~200 lines)
├── db.ts            (~150 lines)
├── repository.ts    (~350 lines)
├── queryBuilder.ts  (~400 lines)
├── metadata.ts      (~200 lines)
└── types.ts         (~100 lines)
```

**Test Suite (Secondary Context):**
```
test/
├── entities/        (Read only when needed)
├── setup.ts        (Read only for test infrastructure)
├── *.test.ts       (Read specific test file for feature)
```

**Forbidden Directories (Never Read):**
- `node_modules/`
- `dist/`
- `.git/`

### Token Efficiency Tips

1. **Start Small:** Read only the specific file mentioned in the task
2. **Expand Deliberately:** Only read additional files if needed for context
3. **Use Grep Strategically:** Search for symbols/functions before reading entire files
4. **Leverage Type Info:** TypeScript types provide context without reading implementations
5. **Trust Architecture:** This CLAUDE.md provides architectural overview - don't re-explore

### Common Task Patterns

**Adding a New Feature:**
1. Read relevant `src/` file(s) only
2. Read corresponding test file
3. Make changes
4. Run tests

**Fixing a Bug:**
1. Read the specific file with the bug
2. Read the failing test (if exists)
3. Fix and verify

**Refactoring:**
1. Read only affected files in `src/`
2. Read related tests
3. Make atomic changes
4. Verify tests pass

### Why This Matters

This ORM library is intentionally compact to:
- **Reduce API Costs:** Fewer tokens per operation
- **Improve Response Quality:** Focused context leads to better Claude understanding
- **Maintain Speed:** Less context processing = faster responses
- **Ensure Consistency:** Claude sees only relevant code

### MCP Server Optimization

If using Claude Code with MCP servers enabled, disable any unused servers with `/mcp` or `@server-name disable` to free up context space for this project's code.

## Notable Implementation Details

- **Global Registry:** Repositories are registered globally in a Map keyed by entity class
- **Metadata Caching:** Column and entity metadata is cached in repositories for performance
- **Transaction Context:** Repositories support tx context switching for transaction handling
- **Safe SQL Composition:** All queries use tagged template literals for SQL injection protection
- **RETURNING Clause:** Insert/update operations use RETURNING for single-query results
- **Array IN Clauses:** Where conditions with arrays use PostgreSQL's ANY(ARRAY[...]) syntax

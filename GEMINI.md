# Project Context: @kaynooo/pg-orm

## Project Overview
**@kaynooo/pg-orm** is a lightweight, fully type-safe Object-Relational Mapping (ORM) library built specifically for **Bun's SQL API** with **PostgreSQL** support. It features a modern builder pattern API (inspired by Zod and Elysia) that provides complete type inference without the need for manual type annotations or decorators.

**Key Characteristics:**
*   **Runtime:** Bun
*   **Database:** PostgreSQL
*   **Language:** TypeScript (ESNext)
*   **Design Pattern:** Builder Pattern, Schema-First, Immutable Schemas
*   **Type Safety:** Full inference from schema definitions

## Architecture & Core Components

The project is structured around a few key components located in `src/`:

*   **`src/orm.ts`**: The main entry point and singleton instance management.
*   **`src/entity.ts`**: Implements the `EntityBuilder` for defining schemas fluently.
*   **`src/field.ts`**: Contains builders for various field types (string, number, json, etc.).
*   **`src/repository.ts`**: The generic repository implementation providing CRUD operations.
*   **`src/query.ts`**: A fluent `QueryBuilder` for constructing type-safe SQL queries.
*   **`src/db.ts`**: Manages the database connection using Bun's native SQL API.
*   **`src/types.ts`**: Defines the TypeScript type system that powers the inference.
*   **`src/traits.ts`**: A mixin system for reusable entity behaviors (e.g., timestamps, soft delete).
*   **`src/migration/`**: Handles schema migrations (generation, execution, rollback).

## Building and Running

The project uses **Bun** for all lifecycle scripts.

### Prerequisites
*   Bun runtime
*   Docker (for local PostgreSQL database)

### Key Commands

*   **Install Dependencies:**
    ```bash
    bun install
    ```

*   **Build Project:**
    ```bash
    bun run build
    ```
    *Generates `dist/` directory.*

*   **Run Tests:**
    ```bash
    bun test
    ```
    *Runs the native Bun test runner.*

*   **Lint & Fix:**
    ```bash
    bun run lint:fix
    ```

*   **Start Local Database:**
    ```bash
    docker compose up -d
    ```

*   **Run Migrations:**
    ```bash
    bun run migrate:run
    ```

*   **Generate Migrations:**
    ```bash
    bun run migrate:generate
    ```

## Development Conventions

*   **Builder Pattern:** Use the chainable builder API for defining entities and fields. Do not use decorators.
*   **Type Inference:** Rely on TypeScript's inference from the schema definition. Avoid manual type assertions where possible.
*   **Explicit Operations:** Prefer explicit query construction over "magic" behavior.
*   **Documentation:** Keep documentation minimal and code self-explanatory. Use comments only for complex logic.
*   **Testing:** Write tests using `bun:test`. Ensure comprehensive coverage for new features.
*   **PostgreSQL Optimization:** The ORM is optimized for Postgres; utilize its specific features (JSONB, Arrays) when appropriate.

## Usage Example

```typescript
import { orm } from '@kaynooo/pg-orm'

// 1. Define Entity
const User = orm.entity('users', f => ({
  name: f.string(),
  email: f.string().unique(),
  role: f.enum(['admin', 'user'])
}).build()

// 2. Connect
await orm.connect(process.env.DATABASE_URL!)

// 3. Use Repository
const users = orm.repo(User)
await users.create({ name: 'Alice', email: 'alice@example.com', role: 'admin' })
```

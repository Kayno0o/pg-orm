import type { ColumnTypes } from '../schema/column-types'
import type { AnyColumns, AnyTableDef, AnyVirtuals, ColumnDef, HasDefault, HookContext, InferSelect, IsNullable, NoDefault, NotGenerated, NotNullable, NotPrimaryKey, Scope, VirtualDef } from '../types/index'
import { DEFAULT_PRIMARY_KEY, SOFT_DELETE_SCOPE } from '../constants'
import { OrmError } from '../errors/index'
import { createColumnTypes } from '../schema/column-types'
import { ColumnBuilder } from '../schema/columns'
import { columnBaseType } from '../schema/inspect'
import { validateIdentifier } from '../schema/validate'

/**
 * A trait is a composable table behavior that adds columns, hooks, virtuals, scopes and metadata.
 * Apply with `table.withTrait(myTrait)`. Built-in traits: `softDelete()`, `timestamps()`, `optimisticLock()`.
 * The generic `TCols` carries the type-level column definitions for proper inference via `withTrait`, and `THost` the columns of the table it applies to, which `withTrait` infers so a trait's callbacks are typed against the row.
 */
export interface Trait<TCols extends AnyColumns = {}, TVirts extends AnyVirtuals = {}, THost extends AnyColumns = any> {
  /**
   * Identifier used to detect duplicate applications. When set, `applyTrait`
   * tracks it in `table.meta._appliedTraits` and throws on re-apply.
   */
  readonly name?: string
  readonly _cols?: TCols
  readonly _virts?: TVirts
  readonly _host?: (row: InferSelect<THost>) => void
  columns?: (t: ColumnTypes) => Record<string, ColumnBuilder<any, any, any, any, any>>
  hooks?: (table: AnyTableDef) => void
  virtuals?: Record<string, (row: any) => any>
  /** Table-wide WHEREs by name, which a call lifts with `withoutScope(name)` or `withoutScopes: [name]`. */
  scopes?: Record<string, Scope<any>>
  meta?: Record<string, unknown>
}

const APPLIED_TRAITS_KEY = '_appliedTraits'
const TRAIT_COLUMNS_KEY = '_traitColumns'
const SCOPES_KEY = '_scopes'

// Apply a trait to a table definition (mutates the table)
export function applyTrait(table: AnyTableDef, trait: Trait<any>): void {
  if (trait.name) {
    const meta = table.meta as Record<string, unknown>
    const applied = (meta[APPLIED_TRAITS_KEY] ??= new Set<string>()) as Set<string>

    if (applied.has(trait.name)) {
      throw new OrmError(
        `Trait "${trait.name}" already applied to table "${table.name}". `
        + `Traits are not idempotent — apply each trait at most once per table.`,
      )
    }

    applied.add(trait.name)
  }

  // Merge columns, recording their names so `traitColumns()` can report every trait-managed column, custom traits included.
  if (trait.columns) {
    const t = createColumnTypes()
    const builders = trait.columns(t)
    const columns = table.columns as Record<string, unknown>
    const meta = table.meta as Record<string, unknown>
    const managed = (meta[TRAIT_COLUMNS_KEY] ??= new Set<string>()) as Set<string>

    for (const key in builders) {
      validateIdentifier(key, 'column')
      const b = builders[key]

      if (b instanceof ColumnBuilder) {
        columns[key] = b._build()
        managed.add(key)
      }
    }
  }

  // Register hooks
  if (trait.hooks) {
    trait.hooks(table)
  }

  // Merge virtuals
  if (trait.virtuals) {
    const virtuals = table.virtuals as Record<string, VirtualDef>

    for (const key in trait.virtuals) {
      virtuals[key] = { _kind: 'virtual', compute: trait.virtuals[key]! } as VirtualDef
    }
  }

  if (trait.scopes) {
    const scopes = ((table.meta as Record<string, unknown>)[SCOPES_KEY] ??= {}) as Record<string, Scope>

    for (const name in trait.scopes) {
      if (Object.hasOwn(scopes, name))
        throw new OrmError(`Scope "${name}" is already declared on table "${table.name}".`)

      scopes[name] = trait.scopes[name]!
    }
  }

  // Merge meta
  if (trait.meta) {
    const meta = table.meta

    for (const key in trait.meta) {
      meta[key] = trait.meta[key]
    }
  }
}

// --- Built-in Traits ---

/**
 * Soft delete trait. Adds a nullable timestamp column, an `isDeleted` virtual and a `softDelete` scope hiding trashed rows.
 * When applied, `deleteMany`/`deleteOne` will SET the column instead of DELETE.
 * Use `.withTrashed()` on queries to include soft-deleted rows.
 * Use `.forceDelete()` for a real DELETE.
 */
export function softDelete<C extends string = 'deletedAt'>(column: C = 'deletedAt' as C): Trait<Record<C, ColumnDef<Date, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>>, { isDeleted: VirtualDef<any, boolean> }> {
  return {
    name: 'softDelete',
    columns: t => ({ [column]: t.timestamptz().nullable() }),
    virtuals: {
      isDeleted: (row: any) => row[column] != null,
    },
    scopes: { [SOFT_DELETE_SCOPE]: e => e.isNull(column) },
    meta: { softDelete: { column } },
  }
}

/**
 * Optimistic locking trait. Adds an integer version column (default 1)
 * that auto-increments on every update. Use `repo.updateWithLock()` to
 * ensure the version matches before updating — throws `StaleRecordError` on conflict.
 */
export function optimisticLock<C extends string = 'version'>(column: C = 'version' as C): Trait<Record<C, ColumnDef<number, NotNullable, HasDefault, NotPrimaryKey, NotGenerated>>> {
  return {
    name: 'optimisticLock',
    columns: t => ({ [column]: t.int4().notNull().default(1) }),
    meta: { optimisticLock: { column } },
  }
}

/**
 * Timestamps trait. Adds `createdAt` and `updatedAt` columns (both default to `now()`).
 * Registers a `beforeUpdate` hook that sets `updatedAt` to the current time on every update.
 */
export function timestamps<C extends string = 'createdAt', U extends string = 'updatedAt'>(opts?: { createdAt?: C, updatedAt?: U }): Trait<Record<C | U, ColumnDef<Date, NotNullable, HasDefault, NotPrimaryKey, NotGenerated>>> {
  const createdAt = (opts?.createdAt ?? 'createdAt') as C
  const updatedAt = (opts?.updatedAt ?? 'updatedAt') as U

  return {
    name: 'timestamps',
    columns: t => ({
      [createdAt]: t.timestamptz().notNull().defaultRaw('now()'),
      [updatedAt]: t.timestamptz().notNull().defaultRaw('now()'),
    }),
    hooks: (table) => {
      table.hook('beforeUpdate', (row) => {
        ;(row as Record<string, unknown>)[updatedAt] = new Date()

        return row
      })
    },
    meta: { timestamps: { createdAt, updatedAt } },
  }
}

/** What `embedding()` takes: the vector column, the text each row is embedded from, and the app's own embedding call. */
export interface EmbeddingOptions<TColumns extends AnyColumns, C extends string, H extends string> {
  /** A nullable `vector` or `halfvec` column, filled after each insert and each update that changes the source. */
  column: C
  /** The text a row is embedded from, given the row as written. */
  source: (row: InferSelect<TColumns>) => string
  /** One vector per text, in order: the app's provider call, batched per write. */
  embed: (texts: string[]) => Promise<ArrayLike<number>[]>
  /** The column the trait adds to hold a hash of the text last embedded, `${column}Hash` by default. */
  hashColumn?: H
}

const EMBEDDING_TYPES = new Set(['vector', 'halfvec'])

function sourceHash(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

/**
 * Embedding trait: fills a vector column from each row's source text through the app's `embed`, after an insert and after an update whose source changed, comparing a hash of the source the trait stores beside it.
 * The rows of one write go to `embed` in one call and are written back by key through the write's executor, skipping hooks, scopes and the version bump, so the row the caller got back stays current.
 */
export function embedding<TColumns extends AnyColumns, C extends keyof TColumns & string, H extends string = `${C}Hash`>(opts: EmbeddingOptions<TColumns, C, H>): Trait<Record<H, ColumnDef<string, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>>, {}, TColumns> {
  const { column, source, embed } = opts
  const hashColumn = opts.hashColumn ?? `${column}Hash`

  validateIdentifier(hashColumn, 'embedding hash column')

  return {
    name: 'embedding',
    columns: t => ({ [hashColumn]: t.text().nullable() }),
    meta: { embedding: { column, hashColumn } },
    hooks: (table) => {
      const vector = (table.columns as AnyColumns)[column]

      if (!vector || !EMBEDDING_TYPES.has(columnBaseType(vector).base) || vector.constraints.some(c => c.type === 'not_null'))
        throw new OrmError(`embedding(): "${table.name}"."${column}" must be a nullable vector or halfvec column, filled after the row is written.`)

      const fill = async (rows: Record<string, unknown>[] | undefined, ctx: HookContext): Promise<void> => {
        const stale = (rows ?? []).map(row => ({ row, text: source(row as InferSelect<TColumns>) })).map(entry => ({ ...entry, hash: sourceHash(entry.text) })).filter(({ row, hash }) => row[hashColumn] !== hash)

        if (stale.length === 0)
          return

        const vectors = await embed(stale.map(entry => entry.text))

        if (vectors.length !== stale.length)
          throw new OrmError(`embedding(): embed() returned ${vectors.length} vectors for ${stale.length} texts.`)

        const pk = (table.primaryKey ?? DEFAULT_PRIMARY_KEY).split(',')
        const updates = stale.map(({ row, hash }, i) => {
          row[column] = Array.from(vectors[i]!)
          row[hashColumn] = hash

          return { ...Object.fromEntries(pk.map(key => [key, row[key]])), [column]: row[column], [hashColumn]: hash }
        })

        await ctx.repo(table).write._patchById(updates)
      }

      table.hook('afterInsert', fill)
      table.hook('afterUpdate', fill)
    },
  }
}

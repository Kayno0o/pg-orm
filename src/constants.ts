// Internal defaults. Configurable ones are mirrored in DbConfig.

/** Max nesting depth for .include() relation chains. Configurable: DbConfig.maxIncludeDepth. */
export const DEFAULT_MAX_INCLUDE_DEPTH = 5

/** Rows per IN (...) chunk in batched relation loading. Sized below PG's 65535 param limit. Configurable: DbConfig.batchChunkSize. */
export const DEFAULT_BATCH_CHUNK_SIZE = 5000

/** Largest `perPage` / `take` paginate() and paginateCursor() accept. Configurable: DbConfig.maxPageSize. */
export const DEFAULT_MAX_PAGE_SIZE = 1000

/** Default chunkSize for stream.offset() / stream.cursor() when not passed in opts. */
export const DEFAULT_STREAM_CHUNK_SIZE = 500

/** Fallback primary key column name when a table doesn't declare `primaryKey`. */
export const DEFAULT_PRIMARY_KEY = 'id'

/** Bind parameters one statement may carry: Postgres counts them in an int16, SQLite caps them at 32766. */
export const MAX_BIND_PARAMS = { postgres: 65535, sqlite: 32766 } as const

/** Parameters held back from a multi-row write's chunk for its statement-wide ones (an upsert's set and where). */
export const STATEMENT_PARAM_RESERVE = 1000

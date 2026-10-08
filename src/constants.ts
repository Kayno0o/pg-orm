// Internal defaults. Configurable ones are mirrored in DbConfig.

/** Max nesting depth for .include() relation chains. Configurable: DbConfig.maxIncludeDepth. */
export const DEFAULT_MAX_INCLUDE_DEPTH = 5

/** Rows per IN (...) chunk in batched relation loading. Sized below PG's 65535 param limit. Configurable: DbConfig.batchChunkSize. */
export const DEFAULT_BATCH_CHUNK_SIZE = 5000

/** Default chunkSize for stream.offset() / stream.cursor() when not passed in opts. */
export const DEFAULT_STREAM_CHUNK_SIZE = 500

/** Fallback primary key column name when a table doesn't declare `primaryKey`. */
export const DEFAULT_PRIMARY_KEY = 'id'

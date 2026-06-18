// Migration-specific regex constants. Module-scoped to avoid recompilation
// on every call (e18e/prefer-static-regex).

export const SPACE_RE = / /g
export const WHERE_RE = /\bWHERE\b/i

// Strips the leading `_` that PostgreSQL prepends to array element type names.
export const ARRAY_UDT_PREFIX_RE = /^_/

// PostgreSQL type aliases — normalized to their canonical names for diffing.
export const SERIAL_RE = /^serial$/
export const BIGSERIAL_RE = /^bigserial$/
export const INT4_RE = /^int4$/
export const INT2_RE = /^int2$/
export const INT8_RE = /^int8$/
export const FLOAT4_RE = /^float4$/
export const FLOAT8_RE = /^float8$/
export const BOOL_RE = /^bool$/
export const TIMESTAMPTZ_RE = /^timestamptz$/
export const TIMETZ_RE = /^timetz$/

// Strips trailing PostgreSQL type casts from column defaults (e.g. `''::text`, `0::integer`, `text[]`).
export const DEFAULT_CAST_RE = /::[\w ]+(\[\])*$/

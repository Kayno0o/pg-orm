// Migration-specific regex constants. Module-scoped to avoid recompilation
// on every call (e18e/prefer-static-regex).

export const SPACE_RE = / /g
export const WHERE_RE = /\bWHERE\b/i

// A type split into its name, its modifier and its array brackets: `varchar(10)[]`. A schema qualifier and identifier quotes are dropped before.
export const TYPE_PARTS_RE = /^([^()[\]]*)(?:\(([^)]*)\))?((?:\[\d*\])*)$/
export const TYPE_QUALIFIER_RE = /^[^(]*\./
// A length or precision inside a normalized type (`character varying(10)`, `timestamp(3) with time zone`), and its array brackets.
export const TYPE_MODIFIER_RE = /\(\d+(?:,\d+)?\)/g
export const ARRAY_SUFFIX_RE = /\[\]$/
export const SERIAL_TYPE_RE = /^(?:small|big)?serial[248]?$/i

// The parts of a default expression: a quoted literal is kept verbatim, the rest loses its spacing, its case and its casts (`''::text`, `::character varying(10)[]`).
export const DEFAULT_LITERAL_RE = /('(?:[^']|'')*')/
export const DEFAULT_CAST_RE = /::(?:"[^"]*"|[a-z_][\w.]*)(?:\([\d,]*\))?(?:\[\d*\])*/g
export const WHITESPACE_RE = /\s+/g
// A quoted plain number (`'0.00'`): Postgres reflects a numeric column's default back unquoted, so both sides drop the quotes before comparing.
export const QUOTED_NUMBER_RE = /^'(-?\d+(?:\.\d+)?)'$/
export const PLAIN_NUMBER_RE = /^-?\d+(?:\.\d+)?$/
export const LONE_LITERAL_RE = /^'((?:[^']|'')*)'$/

// A timestamp as Postgres prints it (`2024-01-01 10:00:00+00`) or as toISOString() writes it (`2024-01-01T10:00:00.000Z`).
export const TIMESTAMP_SEPARATOR_RE = /^(\d{4}-\d{2}-\d{2}) /
export const SHORT_OFFSET_RE = /([+-]\d{2})$/
export const TIME_ZONE_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/

// Pieces Postgres adds or drops when it prints an index predicate or a generated expression back (`WHERE ((kind = 'x'::text))` for `"kind" = 'x'`): casts, a quoted type name like `::"char"` included, identifier quotes, parentheses and spacing.
export const PREDICATE_CAST_RE = /::(?:"[^"]+"|\w+)(?: varying| precision| with(?:out)? time zone)?(?:\[\])*/g
export const PREDICATE_NOISE_RE = /["()\s]/g

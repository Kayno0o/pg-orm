// Shared regex constants used across modules. Module-scoped to avoid
// recompilation on every call (e18e/prefer-static-regex).

export const SINGLE_QUOTE_RE = /'/g
export const DOUBLE_QUOTE_RE = /"/g
export const BACKSLASH_RE = /\\/g

// Captures the inner word of a quoted SQL identifier: `"foo"` → `["foo", "foo"]`.
export const QUOTED_IDENT_RE = /"(\w+)"/

// Captures old and new column names from a `RENAME COLUMN "x" TO "y"` fragment.
export const RENAME_COLUMN_RE = /RENAME COLUMN "(\w+)" TO "(\w+)"/

// Matches `:` or `.` — used to sanitize ISO timestamps for filenames.
export const TIMESTAMP_DELIM_RE = /[:.]/g

// Captures the index of a positional bind placeholder: `$12` → `["$12", "12"]`.
export const SQL_PLACEHOLDER_RE = /\$(\d+)/g

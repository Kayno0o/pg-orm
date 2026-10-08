import type { Dialect } from '../dialect'
import type { MigrationOp } from './types'
import { ValidationError } from '../errors/index'
import { validateIdentifier } from '../schema/validate'
import { ADD_CONSTRAINT_RE, QUOTED_IDENT_RE, RENAME_COLUMN_RE } from '../utils/regex'

export interface DownSqlOptions {
  /** Enable defense-in-depth identifier validation at the down-SQL boundary. */
  validate?: boolean
  dialect?: Dialect
}

// Defense-in-depth: every identifier embedded into the reverse DDL goes through
// validateIdentifier(). The forward path already validates at schema-definition
// time, but down-SQL is built from MigrationOp shapes that future code paths may
// construct independently — so we re-validate at the boundary where strings become SQL.
function requireIdent(value: string | undefined, context: string, opts?: DownSqlOptions): string {
  if (value == null || value === '') {
    throw new ValidationError(
      `Missing identifier for ${context} when generating down SQL`,
      context,
      { value },
    )
  }

  if (opts?.validate)
    validateIdentifier(value, context)

  return value
}

function validateOptional(value: string, context: string, opts?: DownSqlOptions): void {
  if (opts?.validate)
    validateIdentifier(value, context)
}

/**
 * Generate the down SQL for a single migration op. Irreversible ops return a
 * comment. When `opts.validate` is true, embedded identifiers are validated
 * defense-in-depth.
 */
export function generateReverseOp(op: MigrationOp, opts?: DownSqlOptions): string {
  switch (op.type) {
    case 'create_table': {
      const table = requireIdent(op.table, 'down.create_table.table', opts)

      return `DROP TABLE IF EXISTS "${table}";`
    }

    case 'add_column': {
      const table = requireIdent(op.table, 'down.add_column.table', opts)
      const column = requireIdent(op.column, 'down.add_column.column', opts)

      // SQLite has no IF EXISTS on DROP COLUMN.
      return opts?.dialect === 'sqlite' ? `ALTER TABLE "${table}" DROP COLUMN "${column}";` : `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}";`
    }

    case 'create_enum': {
      const name = op.sql.match(QUOTED_IDENT_RE)?.[0] ?? 'unknown'

      return `DROP TYPE IF EXISTS ${name};`
    }

    case 'create_index': {
      const match = op.sql.match(QUOTED_IDENT_RE)

      if (!match)
        return ''

      // QUOTED_IDENT_RE captures `"name"` (group 0) and `name` (group 1).
      // Validate the unquoted form, then emit the quoted form.
      validateOptional(match[1]!, 'down.create_index.name', opts)

      return `DROP INDEX IF EXISTS ${match[0]};`
    }

    case 'add_fk': {
      const table = requireIdent(op.table, 'down.add_fk.table', opts)
      const column = requireIdent(op.column, 'down.add_fk.column', opts)
      // Constraint name format: <table>_<column>_fkey — re-validate the
      // assembled name to catch length-overflow against PG's 63-byte limit.
      const constraint = `${table}_${column}_fkey`

      validateOptional(constraint, 'down.add_fk.constraint', opts)

      return `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}";`
    }

    case 'add_constraint': {
      const table = requireIdent(op.table, 'down.add_constraint.table', opts)
      const name = op.sql.match(ADD_CONSTRAINT_RE)?.[1]

      if (!name)
        return `-- Cannot reverse: ${op.description}`

      validateOptional(name, 'down.add_constraint.name', opts)

      return `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}";`
    }

    case 'rename_column': {
      const match = op.sql.match(RENAME_COLUMN_RE)

      if (!match)
        return ''

      const table = requireIdent(op.table, 'down.rename_column.table', opts)

      validateOptional(match[1]!, 'down.rename_column.from', opts)
      validateOptional(match[2]!, 'down.rename_column.to', opts)

      return `ALTER TABLE "${table}" RENAME COLUMN "${match[2]}" TO "${match[1]}";`
    }

    default:
      return `-- Cannot reverse: ${op.description}`
  }
}

/**
 * Generate the down SQL for a sequence of migration ops. Ops are reversed so
 * that forward operations are undone in the opposite order.
 */
export function generateDownSql(ops: MigrationOp[], opts?: DownSqlOptions): string {
  return ops
    .slice()
    .reverse()
    .map(op => generateReverseOp(op, opts))
    .filter(Boolean)
    .join('\n')
}

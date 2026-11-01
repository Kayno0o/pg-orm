import type { Terminal } from '@kaynooo/cli-kit/prompt'
import type { MigrationOp } from './types'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { colors } from '@kaynooo/utils'
import { MigrationError } from '../errors/index'

/**
 * Interactive TTY confirmation for `db.sync({ confirm: true })`. Prints a colored
 * preview of the SQL about to run and returns true if the user confirms; Enter is yes unless an op is destructive, and a cancel or a stdin ending unanswered is a no.
 * Stdin and stderr must be a terminal: nobody could answer otherwise, so the call refuses before printing anything. Overridable in tests via the `terminal` argument.
 */
export async function promptSync(
  ops: MigrationOp[],
  destructiveOps: MigrationOp[],
  terminal: Terminal = process,
): Promise<boolean> {
  if (!terminal.stdin.isTTY || !terminal.stderr.isTTY)
    throw new MigrationError('sync({ confirm: true }) asks on the terminal, and stdin or stderr is not one: pass allowDestructive instead of confirm when no one can answer.', 'diff')

  const safeOps = ops.filter(o => !o.destructive)

  console.log(`\n${colors.bold.cyan('── Database Sync Preview ──')}\n`)

  if (safeOps.length > 0) {
    console.log(colors.bold.green(`${safeOps.length} safe operation(s):`))

    for (const op of safeOps)
      console.log(`  ${colors.green('+')} ${op.description}`)

    console.log()
  }

  if (destructiveOps.length > 0) {
    console.log(colors.bold.red(`${destructiveOps.length} destructive operation(s):`))

    for (const op of destructiveOps)
      console.log(`  ${colors.red('✗')} ${op.description}`)

    console.log()
  }

  console.log(colors.dim('SQL to execute:'))
  console.log(`${colors.dim(ops.map(o => `  ${o.sql};`).join('\n'))}\n`)

  const question = destructiveOps.length > 0
    ? colors.bold.yellow(`Apply ${ops.length} operation(s) (${destructiveOps.length} destructive)?`)
    : colors.bold(`Apply ${ops.length} operation(s)?`)

  if (await confirm(question, { default: destructiveOps.length === 0, terminal }) === true)
    return true

  console.log(`${colors.dim('Sync cancelled.')}\n`)

  return false
}

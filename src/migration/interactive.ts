import type { MigrationOp } from './types'
import { createInterface } from 'node:readline'
import { colors } from '@kaynooo/utils'
import { MigrationError } from '../errors/index'

/** Default reader: real TTY readline, null once stdin ends without an answer. Overridable in tests via the `reader` argument. */
async function defaultReader(prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    // A close after the answer resolves nothing more: a promise settles once.
    rl.once('close', () => resolve(null))
    rl.question(prompt, (ans: string) => {
      resolve(ans)
      rl.close()
    })
  })
}

/**
 * Interactive TTY confirmation for `db.sync({ confirm: true })`. Prints a colored
 * preview of the SQL about to run and returns true if the user confirms; stdin ending unanswered is a no.
 * Without a reader, stdin must be a terminal: nobody could answer otherwise, so the call refuses before printing anything.
 */
export async function promptSync(
  ops: MigrationOp[],
  destructiveOps: MigrationOp[],
  reader?: (prompt: string) => Promise<string | null>,
): Promise<boolean> {
  if (!reader && !process.stdin.isTTY)
    throw new MigrationError('sync({ confirm: true }) asks on stdin, which is not a terminal: pass allowDestructive instead of confirm when no one can answer.', 'diff')

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

  const prompt = destructiveOps.length > 0
    ? `${colors.bold.yellow(`Apply ${ops.length} operation(s) (${destructiveOps.length} destructive)? [y/N]`)} `
    : `${colors.bold(`Apply ${ops.length} operation(s)? [Y/n]`)} `
  const answer = (await (reader ?? defaultReader)(prompt))?.trim().toLowerCase()

  const defaultYes = destructiveOps.length === 0

  if (answer === 'y' || answer === 'yes' || (defaultYes && answer === ''))
    return true

  console.log(`${colors.dim('Sync cancelled.')}\n`)

  return false
}

import type { MigrationOp } from './types'
import { createInterface } from 'node:readline'
import { colors } from '@kaynooo/utils'

/**
 * Interactive TTY confirmation for `db.sync({ confirm: true })`. Prints a colored
 * preview of the SQL about to run and returns true if the user confirms.
 */
export async function promptSync(ops: MigrationOp[], destructiveOps: MigrationOp[]): Promise<boolean> {
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

  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    rl.question(
      destructiveOps.length > 0
        ? `${colors.bold.yellow(`Apply ${ops.length} operation(s) (${destructiveOps.length} destructive)? [y/N]`)} `
        : `${colors.bold(`Apply ${ops.length} operation(s)? [Y/n]`)} `,
      (ans: string) => {
        rl.close()
        resolve(ans.trim().toLowerCase())
      },
    )
  })

  const defaultYes = destructiveOps.length === 0

  if (answer === 'y' || answer === 'yes' || (defaultYes && answer === ''))
    return true

  console.log(`${colors.dim('Sync cancelled.')}\n`)

  return false
}

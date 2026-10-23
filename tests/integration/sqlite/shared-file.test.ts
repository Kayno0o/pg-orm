import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'bun:test'

const index = join(import.meta.dir, '../../../src/index')

// Each process opens the file, syncs a table and writes rows, as an app and its CLI do on one database.
function script(file: string, prefix: string) {
  return `
  import { Database, defineTable } from '${index}'
  const things = defineTable('things', t => ({ id: t.text().primaryKey() }))
  const db = new Database({ url: 'sqlite://${file}', tables: [things] })
  await db.sync()
  for (let i = 0; i < 40; i++) await db.raw('INSERT INTO "things" ("id") VALUES (?)', ['${prefix}' + i])
  await db.close()
`
}

it('processes opening, syncing and writing one file wait for each other instead of answering SQLITE_BUSY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgorm-shared-'))
  const file = join(dir, 'shared.sqlite')

  try {
    const runs = ['a', 'b', 'c', 'd'].map(prefix => Bun.spawn([process.execPath, '-e', script(file, prefix)], { stdout: 'pipe', stderr: 'pipe' }))
    const results = await Promise.all(runs.map(async run => ({ code: await run.exited, err: await new Response(run.stderr).text() })))

    expect(results).toEqual(runs.map(() => ({ code: 0, err: '' })))
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

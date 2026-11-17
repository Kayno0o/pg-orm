import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { Database, defineTable } from '../../../src/index'

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

it('a read-only transaction leaves the file writable by another connection while it runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pgorm-shared-'))
  const url = `sqlite://${join(dir, 'shared.sqlite')}`
  const things = defineTable('things', t => ({ id: t.text().primaryKey() }))
  const reader = new Database({ url, tables: [things] })
  const writer = new Database({ url, tables: [things] })

  try {
    await reader.sync()

    const seen = await reader.transaction({ accessMode: 'read only' }, async (tx) => {
      const before = await reader.repo(things).using(tx).read.count()
      const start = performance.now()

      await writer.repo(things).write.insertOne({ id: 'a' })

      return { before, waitedMs: performance.now() - start }
    })

    expect(seen.before).toBe(0)
    expect(seen.waitedMs).toBeLessThan(1000)
  }
  finally {
    await reader.close()
    await writer.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

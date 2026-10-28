import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { defineTable, DestructiveOpError } from '../../src/index'
import { applyMigrationFiles, syncMigration } from '../../src/migration/files'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_enum_sync'
const { admin, at, sync } = syncSchemaHarness(SCHEMA)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true })
})

function tickets(values: string[], fallback = 'open') {
  return defineTable('tickets', t => ({
    id: t.serial().primaryKey(),
    state: t.enum('TicketState', values).default(fallback),
  }))
}

async function values(): Promise<string[]> {
  const rows = await admin.raw<{ v: string }>(`SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'TicketState' ORDER BY e.enumsortorder`, [SCHEMA])

  return rows.map(r => r.v)
}

describe('enum changes in sync', () => {
  it('syncs a mixed-case enum name, then finds no drift', async () => {
    await sync([tickets(['open', 'closed'])])
    expect(await values()).toEqual(['open', 'closed'])
    expect(await at([tickets(['open', 'closed'])], db => db.sync())).toEqual({ sql: '', ops: [] })
  })

  it('records an added value and leaves the database untouched when the gate refuses the sync', async () => {
    const orphan = defineTable('orphan', t => ({ id: t.serial().primaryKey() }))

    await sync([tickets(['open']), orphan])
    await expect(sync([tickets(['open', 'closed'])])).rejects.toBeInstanceOf(DestructiveOpError)
    expect(await values()).toEqual(['open'])

    const result = await sync([tickets(['open', 'closed'], 'closed'), orphan])

    expect(result.ops.map(o => o.type)).toContain('alter_enum_add')
    expect(await values()).toEqual(['open', 'closed'])

    const [last] = await admin.raw<{ up_sql: string }>(`SELECT up_sql FROM "${SCHEMA}"."_pgorm_migrations" ORDER BY id DESC LIMIT 1`)

    expect(last!.up_sql).toContain('ADD VALUE IF NOT EXISTS \'closed\'')
  })

  it('applies a CLI sync adding a value its default uses, the file listing the addition', async () => {
    await sync([tickets(['open'])])

    const file = await at([tickets(['open', 'closed'], 'closed')], db => syncMigration(db, new Map([['tickets', tickets(['open', 'closed'], 'closed')]]), { schema: SCHEMA }))

    expect(file!.up).toContain('ADD VALUE IF NOT EXISTS \'closed\'')
    const [column] = await admin.raw<{ d: string }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tickets' AND column_name = 'state'`, [SCHEMA])

    expect(column!.d).toStartWith('\'closed\'::')
  })

  it('applies a migration file adding a value and using it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-orm-enum-'))

    dirs.push(dir)
    await sync([tickets(['open'])])
    writeFileSync(join(dir, '0001_closed.sql'), `-- migrate:up\nALTER TYPE "TicketState" ADD VALUE IF NOT EXISTS 'closed';\nINSERT INTO "tickets" ("state") VALUES ('closed');\n\n-- migrate:down\n`)

    expect(await at([tickets(['open'])], db => applyMigrationFiles(db, dir))).toEqual(['0001_closed.sql'])
    expect(await admin.raw(`SELECT state::text AS state FROM "${SCHEMA}"."tickets"`)).toEqual([{ state: 'closed' }])
  })
})

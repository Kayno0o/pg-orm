import { describe, expect, it } from 'bun:test'
import { introspectLiveSchema } from '../../src/migration/introspect'
import { syncSchemaHarness } from '../helpers/schema-sync'

const SCHEMA = 'pgorm_introspect_fk'
const { admin } = syncSchemaHarness(SCHEMA)

describe('foreign key introspection', () => {
  it('reads same-named and composite foreign keys once per column pair, with their actions', async () => {
    await admin.raw(`
      CREATE TABLE "${SCHEMA}"."users" ("id" int PRIMARY KEY);
      CREATE TABLE "${SCHEMA}"."teams" ("id" int, "org" int, PRIMARY KEY ("id", "org"));
      CREATE TABLE "${SCHEMA}"."posts" ("id" int PRIMARY KEY, "owner" int, CONSTRAINT "owner_fk" FOREIGN KEY ("owner") REFERENCES "${SCHEMA}"."users" ("id") ON DELETE CASCADE);
      CREATE TABLE "${SCHEMA}"."members" ("t" int, "o" int, "owner" int,
        CONSTRAINT "owner_fk" FOREIGN KEY ("owner") REFERENCES "${SCHEMA}"."users" ("id") ON UPDATE SET NULL DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "team_fk" FOREIGN KEY ("t", "o") REFERENCES "${SCHEMA}"."teams" ("id", "org"));
    `)

    const { foreignKeys } = await introspectLiveSchema({ query: (sql, params) => admin.raw(sql, params) }, SCHEMA)
    const rows = foreignKeys.map(fk => [fk.tableName, fk.constraintName, fk.columnName, fk.referencedTable, fk.referencedColumn, fk.onUpdate, fk.onDelete, fk.deferrable ?? null]).sort((a, b) => a.join().localeCompare(b.join()))

    expect(rows).toEqual([
      ['members', 'owner_fk', 'owner', 'users', 'id', 'set null', 'no action', 'deferred'],
      ['members', 'team_fk', 'o', 'teams', 'org', 'no action', 'no action', null],
      ['members', 'team_fk', 't', 'teams', 'id', 'no action', 'no action', null],
      ['posts', 'owner_fk', 'owner', 'users', 'id', 'no action', 'cascade', null],
    ])
  })
})

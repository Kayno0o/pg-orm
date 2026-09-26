import type { AnyColumns, Repository, TableDef } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { Database } from '../../../src/index'
import { postsTable, usersTable } from '../../helpers/fixtures'

// A helper generic only over the columns must accept the repository of a table that also has relations, virtuals and traits.
function columnsOf<C extends AnyColumns>(opts: { table: TableDef<string, C, any, any>, repo: Repository<C>, read: (keyof C & string)[] }): string[] {
  return opts.read
}

describe('Repository<TColumns>', () => {
  it('accepts a repository whose table has relations, virtuals and traits', async () => {
    const db = new Database({ url: 'postgres://unused@127.0.0.1:1/none', tables: [usersTable, postsTable] })

    expect(columnsOf({ table: usersTable, repo: db.repo(usersTable), read: ['id', 'name'] })).toEqual(['id', 'name'])
    expect(columnsOf({ table: postsTable, repo: db.repo(postsTable), read: ['title'] })).toEqual(['title'])

    // @ts-expect-error still checked against the table's columns
    columnsOf({ table: postsTable, repo: db.repo(postsTable), read: ['nope'] })

    await db.close()
  })
})

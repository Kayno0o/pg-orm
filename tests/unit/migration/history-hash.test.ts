import type { MigrationHistoryEntry } from '../../../src/migration/history'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { migrationFilesState } from '../../../src/migration/files'
import { appliedSqlMatches, sqlHash } from '../../../src/migration/history'

const dir = mkdtempSync(join(tmpdir(), 'pg-orm-history-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function entry(name: string, up: string, hash = sqlHash(up), direction: 'up' | 'down' = 'up'): MigrationHistoryEntry {
  return { id: 0, name, sqlHash: hash, upSql: up, downSql: '', appliedAt: new Date(), direction }
}

describe('the history hash', () => {
  it('is sha256 of the SQL, its trailing whitespace ignored', () => {
    expect(sqlHash('SELECT 1')).toMatch(/^[0-9a-f]{64}$/)
    expect(sqlHash('SELECT 1\n\n')).toBe(sqlHash('SELECT 1'))
  })

  it('matches a row recorded before sha256 by its SQL', () => {
    expect(appliedSqlMatches(entry('a', 'SELECT 1', 'q2x1b'), 'SELECT 1\n')).toBe(true)
    expect(appliedSqlMatches(entry('a', 'SELECT 1', 'q2x1b'), 'SELECT 2')).toBe(false)
  })
})

describe('migrationFilesState', () => {
  writeFileSync(join(dir, '0001_a.sql'), '-- migrate:up\nSELECT 1;\n\n-- migrate:down\n')
  writeFileSync(join(dir, '0002_b.sql'), '-- migrate:up\nSELECT 2;\n')
  writeFileSync(join(dir, '0003_c.sql'), '-- migrate:up\nSELECT 3;\n')

  it('reports an applied file whose up changed, and a pending one sorting before an applied migration', () => {
    const state = migrationFilesState(dir, [entry('0001_a', 'SELECT 0;'), entry('0003_c', 'SELECT 3;')])

    expect(state).toEqual({ pending: ['0002_b.sql'], edited: ['0001_a.sql'], outOfOrder: ['0002_b.sql'] })
  })

  it('reads a rolled-back file as pending, and its later up as the one to compare', () => {
    const history = [entry('0001_a', 'SELECT 0;'), entry('0001_a', '', '', 'down'), entry('0001_a', 'SELECT 1;'), entry('0002_b', 'SELECT 2;'), entry('0003_c', 'SELECT 3;'), entry('0003_c', '', '', 'down')]

    expect(migrationFilesState(dir, history)).toEqual({ pending: ['0003_c.sql'], edited: [], outOfOrder: [] })
  })

  it('orders files against applied files only, not against a migration db.sync() recorded with no file', () => {
    expect(migrationFilesState(dir, [entry('2026-10-28T10-00-00-000_ab12cd34_sync', 'SELECT 0;')]).outOfOrder).toEqual([])
  })
})

import { describe, expect, it } from 'bun:test'
import { MigrationError } from '../../../src/errors/index'
import { parseMigrationFile } from '../../../src/migration/files'
import { splitOutsideTransaction } from '../../../src/migration/outside'

const LF = '-- migrate:up\nCREATE TABLE a (id int);\nCREATE INDEX CONCURRENTLY a_id ON a (id);\n\n-- migrate:down\nDROP TABLE a;'

describe('parseMigrationFile', () => {
  it('splits a CRLF file into the same up and down as its LF twin', () => {
    const parsed = parseMigrationFile(LF)

    expect(parsed).toEqual({ up: 'CREATE TABLE a (id int);\nCREATE INDEX CONCURRENTLY a_id ON a (id);\n', down: 'DROP TABLE a;' })
    expect(parseMigrationFile(LF.replaceAll('\n', '\r\n'))).toEqual(parsed)
    expect(parseMigrationFile(`\uFEFF${LF}`)).toEqual(parsed)
  })

  it('reads an empty file as cmdNew writes it, and a down marker on the last line', () => {
    expect(parseMigrationFile('-- migrate:up\n\n\n-- migrate:down\n')).toEqual({ up: '\n', down: '' })
    expect(parseMigrationFile('-- migrate:up\nSELECT 1;\n-- migrate:down')).toEqual({ up: 'SELECT 1;', down: '' })
    expect(parseMigrationFile('-- migrate:up\nSELECT 1;')).toEqual({ up: 'SELECT 1;', down: '' })
  })

  it('refuses a file not starting with the up marker, or holding two down markers', () => {
    expect(() => parseMigrationFile('CREATE TABLE a (id int);', '001_a.sql')).toThrow(MigrationError)
    expect(() => parseMigrationFile('-- migrate:up\nA;\n-- migrate:down\nB;\n-- migrate:down\nC;', '001_a.sql')).toThrow('001_a.sql has 2 `-- migrate:down` lines')
  })

  it('finds a CONCURRENTLY statement in a CRLF file', () => {
    const crlf = 'CREATE TABLE a (id int);\r\nCREATE INDEX CONCURRENTLY a_id ON a (id);\r\n'

    expect(splitOutsideTransaction(crlf).outside).toEqual(['CREATE INDEX CONCURRENTLY a_id ON a (id)'])
    expect(splitOutsideTransaction(parseMigrationFile(LF.replaceAll('\n', '\r\n')).up).outside).toEqual(['CREATE INDEX CONCURRENTLY a_id ON a (id)'])
  })
})

import { describe, expect, it } from 'bun:test'
import { toSqliteText } from '../../../src/sql/sqlite-text'

describe('toSqliteText', () => {
  it('rewrites $N placeholders to ?N, keeping their numbers', () => {
    expect(toSqliteText('SELECT * FROM "t" WHERE "a" = $2 AND "b" = $1 OR "c" = $2').text).toBe('SELECT * FROM "t" WHERE "a" = ?2 AND "b" = ?1 OR "c" = ?2')
  })

  it('leaves a $N inside a literal, an identifier or a comment alone', () => {
    const { text } = toSqliteText(`SELECT '$1', "$2", \`$3\`, [$4], $5 -- $6\n, $7 /* $8 */`)

    expect(text).toBe(`SELECT '$1', "$2", \`$3\`, [$4], ?5 -- $6\n, ?7 /* $8 */`)
  })

  it('reads a doubled quote as part of the literal', () => {
    expect(toSqliteText(`SELECT 'it''s $1', $2`).text).toBe(`SELECT 'it''s $1', ?2`)
  })

  it('leaves a $ inside a word alone', () => {
    expect(toSqliteText('SELECT a$1, $1').text).toBe('SELECT a$1, ?1')
  })

  it('counts the statements, ignoring empty ones and a ; in a literal', () => {
    expect(toSqliteText('SELECT 1').statements).toBe(1)
    expect(toSqliteText(`SELECT ';'; SELECT 2;;`).statements).toBe(2)
    expect(toSqliteText('CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);\n').statements).toBe(2)
  })
})

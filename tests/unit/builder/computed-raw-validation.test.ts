import { describe, expect, it } from 'bun:test'
import { SelectBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'

interface Cols {
  id: any
  name: any
  [key: string]: any
}

function select() {
  return new SelectBuilder<Cols>('users')
}

describe('SelectBuilder.computedRaw — input validation', () => {
  it('accepts a plain safe SQL expression', () => {
    const { sql } = select().computedRaw('COUNT(*) FILTER (WHERE id > 0)', 'active').toSQL()

    expect(sql).toContain('COUNT(*) FILTER (WHERE id > 0) AS "active"')
  })

  it('accepts expressions containing string literals with semicolons inside', () => {
    // The `;` is inside a quoted literal — validator must permit this.
    const { sql } = select().computedRaw('COALESCE(name, \'a;b\')', 'safe_name').toSQL()

    expect(sql).toContain('COALESCE(name, \'a;b\') AS "safe_name"')
  })

  it('rejects statement terminator outside string literal', () => {
    expect(() => select().computedRaw('1); DROP TABLE users; --', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects -- line comment outside string literal', () => {
    expect(() => select().computedRaw('1 -- evil', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects /* block comment outside string literal', () => {
    expect(() => select().computedRaw('1 /* evil */ + 2', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects unterminated single-quote string literal', () => {
    expect(() => select().computedRaw('\'unterminated', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects dollar-quoted string literal', () => {
    expect(() => select().computedRaw('$$ DROP TABLE x $$', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects E\'...\' escape-string literal', () => {
    expect(() => select().computedRaw('E\'\\\';--\'', 'bad'))
      .toThrow(ValidationError)
  })

  it('rejects empty expression', () => {
    expect(() => select().computedRaw('', 'bad')).toThrow(ValidationError)
    expect(() => select().computedRaw('   ', 'bad')).toThrow(ValidationError)
  })

  it('rejects invalid alias even when expression is safe', () => {
    expect(() => select().computedRaw('1 + 1', '1bad'))
      .toThrow(ValidationError)
  })
})

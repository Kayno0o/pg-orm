import { describe, expect, it } from 'bun:test'
import { DeleteBuilder, SelectBuilder, UpdateBuilder } from '../../../src/builder/query'
import { ValidationError } from '../../../src/errors/index'
import { defineTable, isColumn, softDelete, whereColumn } from '../../../src/index'

const users = defineTable('cc_users', t => ({
  id: t.serial().primaryKey(),
  name: t.text(),
  team: t.text(),
}))

type Cols = typeof users.columns

// A name only known at runtime, as from a query string: the types cannot stop it, the builder must.
const runtime = (name: string) => name as keyof Cols & string
const select = () => new SelectBuilder<Cols>(users)

describe('a builder on a table definition refuses a column the table does not have', () => {
  it('knows a column a trait added after a builder already read the table', () => {
    const late = defineTable('cc_late', t => ({ id: t.serial().primaryKey() }))

    expect(() => new SelectBuilder<any>(late).pick('deletedAt').toSQL()).toThrow(ValidationError)
    late.withTrait(softDelete())
    expect(new SelectBuilder<any>(late).pick('deletedAt').toSQL().sql).toBe('SELECT "deletedAt" FROM "cc_late"')
  })

  it('in WHERE, both forms, and in e.ref()', () => {
    expect(() => select().where({ [runtime('nme')]: 'x' }).toSQL()).toThrow(ValidationError)
    expect(() => select().where(e => e.eq(runtime('nme'), 'x')).toSQL()).toThrow(ValidationError)
    expect(() => select().where(e => e.eq('name', e.ref('nme'))).toSQL()).toThrow(ValidationError)
    expect(() => new DeleteBuilder<Cols>(users).where({ [runtime('nme')]: 'x' }).toSQL('sqlite')).toThrow(ValidationError)
    expect(() => new UpdateBuilder<Cols>(users).set({ name: 'y' }).where({ [runtime('nme')]: 'x' }).toSQL()).toThrow(ValidationError)
  })

  it('in pick, omit, orderBy, groupBy, distinctOn, a window and RETURNING', () => {
    expect(() => select().pick(runtime('nme')).toSQL()).toThrow(ValidationError)
    expect(() => select().omit(runtime('nme')).toSQL()).toThrow(ValidationError)
    expect(() => select().orderBy(runtime('nme')).toSQL()).toThrow(ValidationError)
    expect(() => select().groupBy(runtime('nme')).toSQL()).toThrow(ValidationError)
    expect(() => select().distinctOn(runtime('nme')).toSQL()).toThrow(ValidationError)
    expect(() => select().window('w', { partitionBy: ['nme'] }).toSQL()).toThrow(ValidationError)
    expect(() => new DeleteBuilder<Cols>(users).allRows().returning(runtime('nme')).toSQL()).toThrow(ValidationError)
  })

  it('names the column in the error', () => {
    expect(() => select().where({ [runtime('nme')]: 'x' }).toSQL()).toThrow('Unknown column "nme"')
  })

  it('takes a computed alias in ORDER BY, unqualified on a join, and another table\'s alias.col', () => {
    const q = select()
      .join(users, 'o', e => e.eq('id', e.ref('o.id')))
      .pick('team')
      .computed(e => e.countCol(), 'n')
      .groupBy('team')
      .orderBy(runtime('n'), 'desc')
      .toSQL()

    expect(q.sql).toBe('SELECT "cc_users"."team", CAST(COUNT(*) AS double precision) AS "n" FROM "cc_users" INNER JOIN "cc_users" AS "o" ON "cc_users"."id" = "o"."id" GROUP BY "cc_users"."team" ORDER BY "n" DESC')
  })

  it('takes alias.col only for a declared alias and, when its table is known, one of its columns', () => {
    const joined = () => select().join(users, 'o', e => e.eq('id', e.ref('o.id')))

    expect(() => select().where({ [runtime('secrets.password')]: 'x' }).toSQL()).toThrow('Unknown column "secrets.password"')
    expect(() => joined().orderBy(runtime('o.nme')).toSQL()).toThrow('Unknown column "o.nme"')
    expect(() => joined().where({ [runtime('p.name')]: 'x' }).toSQL()).toThrow(ValidationError)
    expect(joined().where({ [runtime('o.name')]: 'x', [runtime('cc_users.team')]: 'y' }).toSQL().sql).toBe('SELECT "cc_users".* FROM "cc_users" INNER JOIN "cc_users" AS "o" ON "cc_users"."id" = "o"."id" WHERE ("o"."name" = $1 AND "cc_users"."team" = $2)')
    expect(select().join('cc_teams', 't', e => e.eq('team', e.ref('t.name'))).orderBy(runtime('t.anything')).toSQL().sql).toContain('ORDER BY "t"."anything" ASC')
  })

  it('takes an enclosing statement\'s alias in a correlated subquery, and only while printing inside it', () => {
    const inner = () => new SelectBuilder<Cols>(users).pick('id').where(e => e.eq('team', e.ref(runtime('m.team'))))
    const q = select().join(users, 'm', e => e.eq('id', e.ref('m.id'))).where(e => e.exists(inner())).toSQL()

    expect(q.sql).toContain('WHERE EXISTS (SELECT "id" FROM "cc_users" WHERE "team" = "m"."team")')
    expect(() => inner().toSQL()).toThrow('Unknown column "m.team"')
  })

  it('checks nothing on a builder given only a table name', () => {
    expect(new SelectBuilder<any>('cc_users').where({ nme: 'x' }).toSQL().sql).toBe('SELECT * FROM "cc_users" WHERE "nme" = $1')
  })
})

describe('runtime column names without casts', () => {
  it('isColumn narrows a string to a column name', () => {
    const sort = 'name'

    expect(isColumn(users, sort)).toBe(true)
    expect(isColumn(users, 'nme')).toBe(false)
    expect(isColumn(users, 'toString')).toBe(false)

    if (isColumn(users, sort))
      expect(select().orderBy(sort).toSQL().sql).toBe('SELECT * FROM "cc_users" ORDER BY "name" ASC')
  })

  it('whereColumn builds a where object for a runtime name and refuses one the table lacks', () => {
    expect(select().where(whereColumn(users, 'name', { iContains: 'al' })).toSQL()).toEqual({ sql: 'SELECT * FROM "cc_users" WHERE "name" ILIKE $1', params: ['%al%'] })
    expect(() => whereColumn(users, 'nme', 'x')).toThrow('"cc_users" has no column "nme"')
    expect(() => whereColumn(users, 'constructor', 'x')).toThrow(ValidationError)
  })
})

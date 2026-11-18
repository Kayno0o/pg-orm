import { defineTable, optimisticLock, softDelete, timestamps } from '../src/index'

// The fake-executor and SQLite suites run every operation on a plain table and on one carrying the traits that add scopes and hooks.

export const itemChildren = defineTable('item_children', t => ({
  id: t.serial().primaryKey(),
  itemId: t.integer().notNull(),
  label: t.text().notNull(),
}))

function defineItems<N extends string>(name: N) {
  return defineTable(name, t => ({
    id: t.serial().primaryKey(),
    name: t.text().notNull(),
    email: t.varchar(255).notNull().unique(),
    role: t.text().notNull().default('user'),
    views: t.integer().notNull().default(0),
  }))
}

export const plainItems = defineItems('plain_items')
  .withRelations(r => ({
    children: r.hasMany(() => itemChildren, 'itemId'),
  }))

export const richItems = defineItems('rich_items')
  .withTrait(softDelete('deletedAt'))
  .withTrait(timestamps())
  .withTrait(optimisticLock())
  .withRelations(r => ({
    children: r.hasMany(() => itemChildren, 'itemId'),
  }))

export const itemTables = [plainItems, richItems, itemChildren]
export type Row = Record<string, unknown>

/** A row as the database returns it, for the rows a fake executor answers with. */
export function itemRow(i: number, rich: boolean): Row {
  const row: Row = { id: i, name: `User ${i}`, email: `user${i}@bench.test`, role: i % 5 === 0 ? 'admin' : 'user', views: i % 1000 }

  return rich ? { ...row, deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0), version: 1 } : row
}

export function childRow(i: number, itemId: number): Row {
  return { id: i, itemId, label: `Child ${i}` }
}

let counter = 0

/** Insert values with an email no earlier call used, so a real table's unique index never rejects them. */
export function freshItems(n: number): { name: string, email: string }[] {
  return Array.from({ length: n }, () => {
    counter++

    return { name: `Bench ${counter}`, email: `bench-${counter}@bench.test` }
  })
}

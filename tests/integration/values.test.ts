import type { Database } from '../../src/index'
import { afterAll, beforeAll, describe } from 'bun:test'
import { createTestDb } from '../helpers/db'
import { valueRoundTripCases, valuesTable } from '../helpers/value-round-trip'

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [valuesTable] })
  await db.raw('DROP TABLE IF EXISTS "value_round_trip"')
  await db.sync({ allowDestructive: true })
})

afterAll(async () => {
  await db.raw('DROP TABLE IF EXISTS "value_round_trip"')
  await db.close({ timeout: 5000 })
})

describe('values on Postgres', () => {
  valueRoundTripCases(() => db)
})

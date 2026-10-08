import { afterAll, beforeAll, describe } from 'bun:test'
import { Database } from '../../../src/index'
import { valueRoundTripCases, valuesTable } from '../../helpers/value-round-trip'

const db = new Database({ url: 'sqlite://:memory:', tables: [valuesTable] })

beforeAll(async () => {
  await db.sync()
})

afterAll(async () => {
  await db.close()
})

describe('values on SQLite', () => {
  valueRoundTripCases(() => db)
})

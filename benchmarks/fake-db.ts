import type { Row } from './item-schema'
import { Database } from '../src/index'
import { itemTables } from './item-schema'

/** A Database whose queries answer from a queue instead of reaching a server, so a benchmark measures the ORM's own work: building the SQL, running hooks and scopes, mapping rows. */
export class FakeDb extends Database {
  private _answers: Row[][] = []

  constructor() {
    // Bun's SQL connects on the first query, which this class never sends.
    super({ url: 'postgres://fake:fake@127.0.0.1:1/fake', tables: itemTables })
  }

  /** Queues the rows the next queries answer, one array per query; an op that sends more queries than queued ones gets no rows. */
  answer(...results: Row[][]): void {
    this._answers = results
  }

  override async query(_sql: string, _params: unknown[]): Promise<Row[]> {
    return this._answers.shift() ?? []
  }
}

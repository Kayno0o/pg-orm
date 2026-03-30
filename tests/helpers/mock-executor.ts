import type { Executable } from '../../src/index'

export interface RecordedQuery {
  sql: string
  params: unknown[]
}

export class MockExecutor implements Executable {
  queries: RecordedQuery[] = []
  results: Record<string, unknown>[][] = []
  sql: any = {} // Stub — not used in unit tests

  preset(rows: Record<string, unknown>[]): void {
    this.results.push(rows)
  }

  async query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    this.queries.push({ sql, params })

    return this.results.shift() ?? []
  }

  reset(): void {
    this.queries = []
    this.results = []
  }

  get lastQuery(): RecordedQuery | undefined {
    return this.queries.at(-1)
  }
}

import { describe, expect, it } from 'bun:test'
import {
  TYPE_PARTS_RE,
  WHERE_RE,
} from '../../../src/migration/regex'

// Snapshot matrix for migration regexes. Each fixture pins one PG catalog edge
// case so accidental regex tweaks fail loudly instead of silently breaking
// introspection or DDL generation.

describe('WHERE_RE — partial-index WHERE detection', () => {
  // Used in diff/indexes.ts to find the WHERE predicate boundary in an
  // existing index definition fetched from pg_indexes.
  it('matches uppercase WHERE as emitted by PG catalog', () => {
    const def = 'CREATE INDEX i ON t USING btree (a) WHERE (a > 0)'

    expect(def.search(WHERE_RE)).toBe(def.indexOf('WHERE'))
  })

  it('matches lowercase where (case-insensitive)', () => {
    expect('create index i on t (a) where a is not null'.search(WHERE_RE)).toBeGreaterThan(-1)
  })

  it('honors word boundary — does not match WHEREVER inside other tokens', () => {
    expect('create index i on t (col_wherever_x)'.search(WHERE_RE)).toBe(-1)
  })

  it('returns -1 when no WHERE clause exists', () => {
    expect('CREATE INDEX i ON t (a, b)'.search(WHERE_RE)).toBe(-1)
  })
})

describe('regex identity — module-scoped instances', () => {
  // The whole point of regex.ts is to avoid recompilation per call
  // (e18e/prefer-static-regex). Confirm the exports really are singletons.
  it('exports the same regex instance across imports', async () => {
    const reimport = await import('../../../src/migration/regex')

    expect(reimport.TYPE_PARTS_RE).toBe(TYPE_PARTS_RE)
    expect(reimport.WHERE_RE).toBe(WHERE_RE)
  })
})

import { describe, expect, it } from 'bun:test'
import {
  SPACE_RE,
  TYPE_PARTS_RE,
  WHERE_RE,
} from '../../../src/migration/regex'

// Snapshot matrix for migration regexes. Each fixture pins one PG catalog edge
// case so accidental regex tweaks fail loudly instead of silently breaking
// introspection or DDL generation.

describe('SPACE_RE — FK action rule normalization', () => {
  // Used in introspect.ts on FK update/delete rule strings from pg_catalog.
  it('replaces every space (global) so "NO ACTION" → "no action"', () => {
    expect('NO ACTION'.toLowerCase().replace(SPACE_RE, ' ')).toBe('no action')
  })

  it('collapses adjacent words separated by single spaces in "SET DEFAULT"', () => {
    expect('SET DEFAULT'.toLowerCase().replace(SPACE_RE, ' ')).toBe('set default')
  })

  it('is global — every occurrence is replaced, not just the first', () => {
    expect('a b c'.replace(SPACE_RE, '_')).toBe('a_b_c')
  })
})

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

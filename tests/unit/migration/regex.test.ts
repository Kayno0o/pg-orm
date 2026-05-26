import { describe, expect, it } from 'bun:test'
import {
  ARRAY_UDT_PREFIX_RE,
  BIGSERIAL_RE,
  BOOL_RE,
  FLOAT4_RE,
  FLOAT8_RE,
  INT2_RE,
  INT4_RE,
  INT8_RE,
  SERIAL_RE,
  SPACE_RE,
  TIMESTAMPTZ_RE,
  TIMETZ_RE,
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

describe('ARRAY_UDT_PREFIX_RE — array element type unwrap', () => {
  // Used in introspect.ts: pg_type prefixes array element type names with `_`
  // (e.g. `_int4` for int4[]). The regex strips exactly the leading underscore.
  it('strips a single leading underscore', () => {
    expect('_int4'.replace(ARRAY_UDT_PREFIX_RE, '')).toBe('int4')
  })

  it('strips only the leading underscore, never internal ones', () => {
    expect('_my_custom_type'.replace(ARRAY_UDT_PREFIX_RE, '')).toBe('my_custom_type')
  })

  it('is a no-op when there is no leading underscore', () => {
    expect('text'.replace(ARRAY_UDT_PREFIX_RE, '')).toBe('text')
  })
})

describe('PG type-alias normalization regexes', () => {
  // Used in ddl.ts to canonicalize alias type names (PG accepts `int4` but
  // pg_catalog reports `integer`). Each regex must be anchored — partial
  // matches would corrupt longer type names like `int4range` or `serialize`.
  const aliasCases: [RegExp, string, string, string[]][] = [
    [SERIAL_RE, 'serial', 'integer', ['serialize', 'bigserial', 'smallserial']],
    [BIGSERIAL_RE, 'bigserial', 'bigint', ['serial', 'bigserialize']],
    [INT4_RE, 'int4', 'integer', ['int4range', 'int', 'int8']],
    [INT2_RE, 'int2', 'smallint', ['int2vector', 'int']],
    [INT8_RE, 'int8', 'bigint', ['int8range', 'int']],
    [FLOAT4_RE, 'float4', 'real', ['float8', 'float']],
    [FLOAT8_RE, 'float8', 'double precision', ['float4', 'float']],
    [BOOL_RE, 'bool', 'boolean', ['boolean', 'booltest']],
    [TIMESTAMPTZ_RE, 'timestamptz', 'timestamp with time zone', ['timestamptz_thing', 'timestamp']],
    [TIMETZ_RE, 'timetz', 'time with time zone', ['timetz_thing', 'time']],
  ]

  for (const [re, alias, canonical, rejects] of aliasCases) {
    describe(`${alias} → ${canonical}`, () => {
      it(`rewrites "${alias}" to "${canonical}"`, () => {
        expect(alias.replace(re, canonical)).toBe(canonical)
      })

      it(`is fully anchored — does not match longer tokens`, () => {
        for (const reject of rejects) {
          expect(reject.replace(re, canonical)).toBe(reject)
        }
      })
    })
  }
})

describe('regex identity — module-scoped instances', () => {
  // The whole point of regex.ts is to avoid recompilation per call
  // (e18e/prefer-static-regex). Confirm the exports really are singletons.
  it('exports the same regex instance across imports', async () => {
    const reimport = await import('../../../src/migration/regex')

    expect(reimport.SERIAL_RE).toBe(SERIAL_RE)
    expect(reimport.WHERE_RE).toBe(WHERE_RE)
  })
})

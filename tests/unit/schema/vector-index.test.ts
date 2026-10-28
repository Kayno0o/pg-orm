import { describe, expect, it } from 'bun:test'
import { SelectBuilder } from '../../../src/builder/query'
import { defineTable, DialectError, ValidationError } from '../../../src/index'
import { buildCreateIndexSql } from '../../../src/migration/ddl'
import { diffSchema } from '../../../src/migration/index'
import { sqliteCreateIndex } from '../../../src/migration/sqlite/ddl'

const select = () => new SelectBuilder<any>('t')
const base = () => defineTable('docs', t => ({ id: t.int4().primaryKey(), embedding: t.vector(3) }))

describe('vector index declarations', () => {
  it('accepts hnsw and ivfflat with an operator class and storage parameters', () => {
    const table = base().withIndexes([
      { name: 'a', columns: ['embedding'], method: 'hnsw', opclass: { embedding: 'vector_cosine_ops' }, with: { m: 16, efConstruction: 64 } },
      { name: 'b', columns: ['embedding'], method: 'ivfflat', opclass: { embedding: 'vector_l2_ops' }, with: { lists: 100 } },
    ])

    expect(buildCreateIndexSql('docs', table.indexes[0]!)).toBe('CREATE INDEX "a" ON "docs" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)')
    expect(buildCreateIndexSql('docs', table.indexes[1]!)).toBe('CREATE INDEX "b" ON "docs" USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100)')
  })

  it('takes them from a column too', () => {
    const table = defineTable('docs', t => ({ id: t.int4().primaryKey(), embedding: t.vector(3).index({ method: 'hnsw', opclass: 'vector_ip_ops', with: { m: 8 } }) }))

    expect(buildCreateIndexSql('docs', table.indexes[0]!)).toBe('CREATE INDEX "docs_embedding_idx" ON "docs" USING hnsw ("embedding" vector_ip_ops) WITH (m = 8)')
  })

  it('refuses a parameter that is not a positive integer, or that the method does not take', () => {
    const idx = (method: 'hnsw' | 'ivfflat' | 'btree', w: object) => () => base().withIndexes([{ columns: ['embedding'], method, with: w as never }])

    expect(idx('hnsw', { m: Number.NaN })).toThrow(ValidationError)
    expect(idx('hnsw', { m: 1.5 })).toThrow(ValidationError)
    expect(idx('hnsw', { efConstruction: -1 })).toThrow(ValidationError)
    expect(idx('hnsw', { m: '16; DROP TABLE x' })).toThrow(ValidationError)
    expect(idx('hnsw', { lists: 10 })).toThrow(ValidationError)
    expect(idx('ivfflat', { m: 10 })).toThrow(ValidationError)
    expect(idx('btree', { m: 10 })).toThrow(ValidationError)
    expect(idx('hnsw', { bogus: 1 })).toThrow(ValidationError)
    expect(() => defineTable('d', t => ({ id: t.int4().primaryKey(), e: t.vector(3).index({ method: 'hnsw', with: { m: 0 } }) }))).toThrow(ValidationError)
  })

  it('diffs method, operator class and parameters against the live definition, and leaves an unchanged one alone', () => {
    const table = (opclass: string, w: { m?: number, efConstruction?: number }) => defineTable('docs', t => ({ id: t.int4().primaryKey(), embedding: t.vector(3) }))
      .withIndexes([{ name: 'docs_emb', columns: ['embedding'], method: 'hnsw', opclass: { embedding: opclass }, with: w }])
    const live = (def: string) => ({
      tables: [{
        name: 'docs',
        columns: [
          { name: 'id', dataType: 'integer', isNullable: false, defaultValue: null, isPrimaryKey: true, isUnique: false, isGenerated: false },
          { name: 'embedding', dataType: 'vector(3)', isNullable: false, defaultValue: null, isPrimaryKey: false, isUnique: false, isGenerated: false },
        ],
      }],
      enums: [],
      extensions: ['vector'],
      indexes: [{ name: 'docs_emb', tableName: 'docs', columns: ['embedding'], isUnique: false, method: 'hnsw', definition: `CREATE INDEX docs_emb ON public.docs USING hnsw (embedding ${def}`, isValid: true }],
    })
    const run = (opclass: string, w: { m?: number, efConstruction?: number }, def: string) => diffSchema(live(def), new Map([['docs', table(opclass, w)]])).map(o => o.type)

    expect(run('vector_cosine_ops', { m: 16, efConstruction: 64 }, 'vector_cosine_ops) WITH (m=\'16\', ef_construction=\'64\')')).toEqual([])
    expect(run('vector_cosine_ops', {}, 'vector_cosine_ops)')).toEqual([])
    expect(run('vector_cosine_ops', { m: 16 }, 'vector_cosine_ops) WITH (m=\'8\')')).toEqual(['drop_index', 'create_index'])
    expect(run('vector_l2_ops', {}, 'vector_cosine_ops)')).toEqual(['drop_index', 'create_index'])
    expect(run('vector_cosine_ops', { m: 16 }, 'vector_cosine_ops)')).toEqual(['drop_index', 'create_index'])
  })

  it('adds the vector extension when a table has a vector column and the live database lacks it', () => {
    const without = diffSchema({ tables: [], enums: [], extensions: [] }, new Map([['docs', base()]]))
    const withIt = diffSchema({ tables: [], enums: [], extensions: ['vector'] }, new Map([['docs', base()]]))
    const half = diffSchema({ tables: [], enums: [], extensions: [] }, new Map([['h', defineTable('h', t => ({ id: t.int4().primaryKey(), v: t.halfvec(2) }))]]))
    const plain = diffSchema({ tables: [], enums: [], extensions: [] }, new Map([['p', defineTable('p', t => ({ id: t.int4().primaryKey() }))]]))

    expect(without[0]).toMatchObject({ type: 'create_extension', sql: 'CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA public', destructive: false })
    expect(half[0]?.type).toBe('create_extension')
    expect(withIt.map(o => o.type)).toEqual(['create_table'])
    expect(plain.map(o => o.type)).toEqual(['create_table'])
  })

  it('names the vector features SQLite cannot hold', () => {
    const table = base().withIndexes([{ name: 'a', columns: ['embedding'], method: 'hnsw', opclass: { embedding: 'vector_cosine_ops' } }])

    expect(() => sqliteCreateIndex('docs', table.indexes[0]!)).toThrow(DialectError)
    expect(() => select().orderBy(e => e.vectorL1Distance('embedding', [1])).toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().orderBy(e => e.bitHammingDistance('bits', '101')).toSQL('sqlite')).toThrow(DialectError)
    expect(() => select().orderBy(e => e.bitJaccardDistance('bits', '101')).toSQL('sqlite')).toThrow(DialectError)
  })

  it('writes the distances with the cast of the type they compare', () => {
    const sql = (cb: (e: any) => unknown) => select().orderBy(cb as never).toSQL()

    expect(sql(e => e.vectorL1Distance('v', [1, 2]))).toMatchObject({ sql: expect.stringContaining('"v" <+> $1::vector'), params: ['[1,2]'] })
    expect(sql(e => e.vectorCosineDistance('v', [1, 2], 'halfvec'))).toMatchObject({ sql: expect.stringContaining('<=> $1::halfvec') })
    expect(sql(e => e.vectorL2Distance('v', '{1:1}/3'))).toMatchObject({ sql: expect.stringContaining('<-> $1::sparsevec'), params: ['{1:1}/3'] })
    expect(sql(e => e.bitHammingDistance('v', '1010'))).toMatchObject({ sql: expect.stringContaining('"v" <~> $1::bit(4)'), params: ['1010'] })
    expect(sql(e => e.bitJaccardDistance('v', '101'))).toMatchObject({ sql: expect.stringContaining('<%> $1::bit(3)') })
    expect(() => sql(e => e.bitHammingDistance('v', '10x'))).toThrow(ValidationError)
  })

  it('refuses search settings that are not numbers in range', () => {
    expect(() => select().vectorSearch({ efSearch: Number.NaN })).toThrow(ValidationError)
    expect(() => select().vectorSearch({ efSearch: 1.5 })).toThrow(ValidationError)
    expect(() => select().vectorSearch({ probes: 0 })).toThrow(ValidationError)
    expect(() => select().vectorSearch({ iterativeScan: 'bogus' as never })).toThrow(ValidationError)
    expect(select().vectorSearch({ efSearch: 100 }).getState().vectorSearch).toEqual({ efSearch: 100 })
  })
})

import { describe, expect, it } from 'bun:test'
import { ValidationError } from '../../../src/errors/index'
import { normalizeDbConfig, validateDbConfig } from '../../../src/sql/config'

describe('validateDbConfig', () => {
  it('accepts an empty config', () => {
    expect(() => validateDbConfig({})).not.toThrow()
  })

  it('accepts a non-negative finite statementTimeout', () => {
    expect(() => validateDbConfig({ statementTimeout: 0 })).not.toThrow()
    expect(() => validateDbConfig({ statementTimeout: 1000 })).not.toThrow()
  })

  it('rejects a negative statementTimeout', () => {
    expect(() => validateDbConfig({ statementTimeout: -1 })).toThrow(ValidationError)
  })

  it('rejects a non-finite statementTimeout', () => {
    expect(() => validateDbConfig({ statementTimeout: Number.NaN })).toThrow(ValidationError)
    expect(() => validateDbConfig({ statementTimeout: Number.POSITIVE_INFINITY })).toThrow(ValidationError)
  })

  it('rejects a negative idleInTransactionTimeout', () => {
    expect(() => validateDbConfig({ idleInTransactionTimeout: -100 })).toThrow(ValidationError)
  })

  it('rejects a non-finite idleInTransactionTimeout', () => {
    expect(() => validateDbConfig({ idleInTransactionTimeout: Number.NaN })).toThrow(ValidationError)
  })

  it('attaches the context and value to the ValidationError', () => {
    try {
      validateDbConfig({ statementTimeout: -1 })
      expect.unreachable()
    }
    catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).context).toBe('DbConfig.statementTimeout')
      expect((err as ValidationError).value).toBe(-1)
    }
  })
})

describe('normalizeDbConfig', () => {
  it('returns an empty options bag for an empty config', () => {
    expect(normalizeDbConfig({})).toEqual({})
  })

  it('passes through driver-level options', () => {
    const out = normalizeDbConfig({
      url: 'postgres://localhost/test',
      hostname: 'localhost',
      port: 5432,
      database: 'test',
      username: 'u',
    })

    expect(out).toEqual({
      url: 'postgres://localhost/test',
      hostname: 'localhost',
      port: 5432,
      database: 'test',
      username: 'u',
    })
  })

  it('strips pg-orm-only fields', () => {
    const noop = (): void => undefined
    const out = normalizeDbConfig({
      tables: [],
      schema: 'public',
      statementTimeout: 100,
      idleInTransactionTimeout: 200,
      onQuery: noop,
      onSlowQuery: noop,
      onError: noop,
      slowQueryThreshold: 1000,
      onPingError: noop,
      onCallbackError: noop,
      retry: { maxRetries: 3 },
      maxIncludeDepth: 10,
      batchChunkSize: 100,
      defaultLimit: 25,
      redactParams: p => p,
      cacheSize: 0,
      url: 'postgres://localhost/test',
    })

    expect(out).toEqual({ url: 'postgres://localhost/test' })
  })

  it('flattens pool options onto the top-level', () => {
    const out = normalizeDbConfig({
      pool: {
        max: 10,
        idleTimeout: 30_000,
        maxLifetime: 60_000,
        connectionTimeout: 5_000,
      },
    })

    expect(out).toEqual({
      max: 10,
      idleTimeout: 30_000,
      maxLifetime: 60_000,
      connectionTimeout: 5_000,
    })
  })

  it('drops undefined values from connOpts', () => {
    const out = normalizeDbConfig({
      url: undefined,
      hostname: 'localhost',
      port: undefined,
    })

    expect(out).toEqual({ hostname: 'localhost' })
    expect('url' in out).toBe(false)
    expect('port' in out).toBe(false)
  })

  it('drops undefined pool sub-fields', () => {
    const out = normalizeDbConfig({
      pool: { max: 10, idleTimeout: undefined },
    })

    expect(out).toEqual({ max: 10 })
    expect('idleTimeout' in out).toBe(false)
  })
})

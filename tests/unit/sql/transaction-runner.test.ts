import type { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'
import { OrmError, UniqueError, ValidationError } from '../../../src/errors/index'
import { queryContextStorage } from '../../../src/sql/base-executor'
import { TransactionRunner } from '../../../src/sql/transaction-runner'

interface FakeDriver {
  unsafe: (sql: string, params: unknown[]) => Promise<unknown[]>
  begin: <T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
}

async function emptyClose(): Promise<void> {
  return undefined
}

function makeSqlFake(beginImpl?: <T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>): InstanceType<typeof SQL> {
  const fake: FakeDriver = {
    unsafe: async () => [],
    begin: beginImpl ?? (async fn => fn({} as InstanceType<typeof SQL>)),
    savepoint: async fn => fn({} as InstanceType<typeof SQL>),
    close: emptyClose,
  }

  return fake as unknown as InstanceType<typeof SQL>
}

describe('TransactionRunner', () => {
  it('fires onCommit callbacks after commit', async () => {
    const fired: string[] = []
    const runner = new TransactionRunner(makeSqlFake(), {})

    const result = await runner.run(async (tx) => {
      tx.onCommit(() => {
        fired.push('a')
      })
      tx.onCommit(() => {
        fired.push('b')
      })

      return 'ok'
    })

    expect(result).toBe('ok')
    expect(fired).toEqual(['a', 'b'])
  })

  it('fires onRollback callbacks on throw and rethrows the original error', async () => {
    const fired: unknown[] = []
    const runner = new TransactionRunner(
      makeSqlFake(async (fn) => {
        // Mimic bun:sql's begin: propagates throws from the body.
        return fn({} as InstanceType<typeof SQL>)
      }),
      {},
    )

    await expect(runner.run(async (tx) => {
      tx.onRollback((err) => {
        fired.push(err)
      })

      throw new Error('rollback me')
    })).rejects.toThrow('rollback me')

    expect(fired).toHaveLength(1)
    expect((fired[0] as Error).message).toBe('rollback me')
  })

  it('routes a single throwing callback to onCallbackError', async () => {
    const seen: { kind: string, error: unknown }[] = []
    const runner = new TransactionRunner(makeSqlFake(), {
      onCallbackError: e => seen.push({ kind: e.kind, error: e.error }),
    })

    await runner.run(async (tx) => {
      tx.onCommit(() => {
        throw new Error('cb fail')
      })
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.kind).toBe('onCommit')
    expect((seen[0]?.error as Error).message).toBe('cb fail')
  })

  it('bundles multiple commit-callback failures into an AggregateError', async () => {
    const seen: { kind: string, error: unknown }[] = []
    const runner = new TransactionRunner(makeSqlFake(), {
      onCallbackError: e => seen.push({ kind: e.kind, error: e.error }),
    })

    await runner.run(async (tx) => {
      tx.onCommit(() => {
        throw new Error('a')
      })
      tx.onCommit(() => {
        throw new Error('b')
      })
      tx.onCommit(() => {
        throw new Error('c')
      })
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.error).toBeInstanceOf(AggregateError)
    expect((seen[0]?.error as AggregateError).errors).toHaveLength(3)
  })

  it('continues firing later callbacks even when an earlier one throws', async () => {
    const fired: string[] = []
    const swallow = (): void => undefined
    const runner = new TransactionRunner(makeSqlFake(), { onCallbackError: swallow })

    await runner.run(async (tx) => {
      tx.onCommit(() => {
        fired.push('a')

        throw new Error('a-fail')
      })
      tx.onCommit(() => {
        fired.push('b')
      })
      tx.onCommit(() => {
        fired.push('c')
      })
    })

    expect(fired).toEqual(['a', 'b', 'c'])
  })

  it('replays the ambient ALS context inside the transaction body', async () => {
    const runner = new TransactionRunner(
      makeSqlFake(<T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>): Promise<T> => {
        // Simulate bun:sql losing ALS by stepping outside the store before
        // invoking the callback — runner must restore it.
        return new Promise<T>((resolve, reject) => {
          setImmediate(async () => {
            try {
              resolve(await fn({} as InstanceType<typeof SQL>))
            }
            catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
        })
      }),
      {},
    )

    let observed: unknown

    await queryContextStorage.run({ requestId: 'r-1' }, async () => {
      await runner.run(async () => {
        observed = queryContextStorage.getStore()
      })
    })

    expect(observed).toEqual({ requestId: 'r-1' })
  })

  it('passes opts.context onto the TransactionClient', async () => {
    const runner = new TransactionRunner(makeSqlFake(), {})

    let txContext: Record<string, unknown> | undefined

    await runner.run({ context: { traceId: 't-1' } }, async (tx) => {
      txContext = tx._context
    })

    expect(txContext).toEqual({ traceId: 't-1' })
  })

  describe('a nested call', () => {
    // A begin whose transaction handle opens savepoints through `savepoint`.
    function runnerWithSavepoint(savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>): TransactionRunner {
      return new TransactionRunner(makeSqlFake(async fn => fn({ savepoint } as unknown as InstanceType<typeof SQL>)), {})
    }

    it('maps a driver failure opening the savepoint to a typed error', async () => {
      const runner = runnerWithSavepoint(async () => {
        throw Object.assign(new Error('savepoint failed'), { errno: '08006' })
      })

      await runner.run(async () => {
        let caught: unknown

        try {
          await runner.run(async () => 'never runs')
        }
        catch (err) {
          caught = err
        }

        expect(caught).toBeInstanceOf(OrmError)
      })
    })

    it('maps a driver failure releasing the savepoint, and hands the mapped error to onRollback', async () => {
      const seen: unknown[] = []
      const runner = runnerWithSavepoint(async (fn) => {
        await fn({} as InstanceType<typeof SQL>)

        throw Object.assign(new Error('release failed'), { errno: '08006' })
      })

      await runner.run(async () => {
        let caught: unknown

        try {
          await runner.run(async (inner) => {
            inner.onRollback((err) => {
              seen.push(err)
            })
          })
        }
        catch (err) {
          caught = err
        }

        expect(caught).toBeInstanceOf(OrmError)
        expect(seen).toEqual([caught])
      })
    })

    it('passes the body\'s own error through untouched', async () => {
      const bodyError = new UniqueError('dup', 'INSERT', [], { constraint: 'k', table: 't', column: 'c' })
      const runner = runnerWithSavepoint(async fn => fn({} as InstanceType<typeof SQL>))

      await runner.run(async () => {
        await expect(runner.run(async () => {
          throw bodyError
        })).rejects.toBe(bodyError)
      })
    })
  })

  describe('on SQLite', () => {
    // A begin whose transaction handle answers every statement, failing the one lifting `query_only`.
    function readOnlyRunner(begun: string[]): TransactionRunner {
      const sqlTx = {
        unsafe: async (sql: string) => {
          if (sql === 'PRAGMA query_only = OFF')
            throw new Error('restore failed')

          return []
        },
      } as unknown as InstanceType<typeof SQL>

      return new TransactionRunner(makeSqlFake(async (fn) => {
        begun.push('BEGIN')

        return fn(sqlTx)
      }), {}, 'sqlite')
    }

    it('rethrows the error of the body when lifting query_only fails after it', async () => {
      const bodyError = new Error('body failed')

      await expect(readOnlyRunner([]).run({ accessMode: 'read only' }, async () => {
        throw bodyError
      })).rejects.toBe(bodyError)
    })

    it('refuses an unknown isolation level before BEGIN', async () => {
      const begun: string[] = []

      await expect(readOnlyRunner(begun).run({ isolation: 'bogus' as never }, async () => 'never runs')).rejects.toBeInstanceOf(ValidationError)
      expect(begun).toEqual([])
    })
  })
})

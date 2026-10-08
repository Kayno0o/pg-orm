// Barrel — keeps existing `from '../sql/executor'` imports working after the
// internal split into base-executor / retry / drain / tx-sql / transaction /
// database. Add new exports at the new file, not here.

// Re-export for the array-serializer unit test.
export { serializePgArray } from './adapter'
export {
  BaseExecutor,
  type CallbackErrorEvent,
  type Executable,
  type QueryErrorEvent,
  type QueryEvent,
  type SlowQueryEvent,
} from './base-executor'
export { Database, type DbConfig } from './database'

export {
  TransactionClient,
  type TransactionOptions,
} from './transaction'

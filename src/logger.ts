/**
 * Query logging system for @kaynooo/pg-orm
 *
 * Usage:
 * ```typescript
 * import { orm, type QueryLogEntry } from '@kaynooo/pg-orm'
 *
 * await orm.connect({
 *   connectionString: process.env.DATABASE_URL,
 *   logging: {
 *     enabled: true,
 *     logger: (entry: QueryLogEntry) => {
 *       console.log(`[${entry.operation}] ${entry.query} (${entry.duration}ms)`)
 *     }
 *   }
 * })
 * ```
 *
 * Note: Automatic integration with Repository queries is planned for a future release.
 * For now, the logging infrastructure is in place and can be manually invoked.
 */

export interface QueryLogEntry {
  query: string
  params: unknown[]
  duration: number
  timestamp: Date
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRANSACTION' | 'OTHER'
  table?: string
  error?: Error
}

export type QueryLogger = (entry: QueryLogEntry) => void | Promise<void>

export interface QueryLoggingConfig {
  logger?: QueryLogger
  enabled?: boolean
}

class QueryLoggingContext {
  private logger?: QueryLogger
  private enabled = false

  configure(config: QueryLoggingConfig): void {
    this.logger = config.logger
    this.enabled = config.enabled ?? false
  }

  async log(entry: QueryLogEntry): Promise<void> {
    if (!this.enabled || !this.logger) {
      return
    }

    try {
      await this.logger(entry)
    }
    catch (error) {
      // Ignore logging errors to prevent disrupting normal operations
      console.error('Query logger error:', error)
    }
  }

  isEnabled(): boolean {
    return this.enabled && Boolean(this.logger)
  }
}

export const queryLogger = new QueryLoggingContext()

export function extractOperation(query: string): QueryLogEntry['operation'] {
  const normalized = query.trim().toUpperCase()

  if (normalized.startsWith('SELECT'))
    return 'SELECT'

  if (normalized.startsWith('INSERT'))
    return 'INSERT'

  if (normalized.startsWith('UPDATE'))
    return 'UPDATE'

  if (normalized.startsWith('DELETE'))
    return 'DELETE'

  if (normalized.startsWith('BEGIN') || normalized.startsWith('COMMIT') || normalized.startsWith('ROLLBACK')) {
    return 'TRANSACTION'
  }

  return 'OTHER'
}

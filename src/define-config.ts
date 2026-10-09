import type { IgnoreTables } from './migration/plan'
import type { Database } from './sql/database'

export interface PgOrmConfig {
  db: Database
  migrationsDir?: string | undefined
  /** Tables the CLI neither creates, changes nor drops: a name, or a pattern names are tested against. */
  ignoreTables?: IgnoreTables | undefined
}

export function defineConfig(config: PgOrmConfig): PgOrmConfig {
  return config
}

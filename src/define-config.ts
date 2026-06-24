import type { Database } from './sql/database'

export interface PgOrmConfig {
  db: Database
  migrationsDir?: string
}

export function defineConfig(config: PgOrmConfig): PgOrmConfig {
  return config
}

import { DialectError } from './errors/index'

/** The SQL a database speaks, chosen from its connection URL. */
export type Dialect = 'postgres' | 'sqlite'

const SQLITE_URL_RE = /^sqlite:(?:\/\/)?/

/** A `sqlite:` URL opens a SQLite file (`sqlite://:memory:` keeps it in memory), anything else reaches Postgres. */
export function dialectOfUrl(url: string | undefined): Dialect {
  return url !== undefined && SQLITE_URL_RE.test(url) ? 'sqlite' : 'postgres'
}

/** The file a `sqlite:` URL names: `sqlite://./data/app.db` is `./data/app.db`, `sqlite:///srv/app.db` is `/srv/app.db`. */
export function sqliteFilename(url: string): string {
  return url.replace(SQLITE_URL_RE, '') || ':memory:'
}

/** The dialect an executor speaks; one built outside pg-orm without saying so speaks Postgres. */
export function dialectOf(executor: { dialect?: Dialect }): Dialect {
  return executor.dialect ?? 'postgres'
}

/** Throws for a feature only Postgres has, when the dialect is SQLite. */
export function requirePostgres(dialect: Dialect, feature: string): void {
  if (dialect === 'sqlite')
    throw new DialectError(feature, dialect)
}

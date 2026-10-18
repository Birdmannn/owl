import pg from 'pg';

/** Small pools per warm function; use a pooled PostgreSQL URL on serverless hosts. */
export function postgresPool(url: string) {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000, allowExitOnIdle: true });
  // pg discards failed idle connections; keep provider errors (which may contain credentials) out of logs.
  pool.on('error', () => {});
  return pool;
}

/** Serialize first-run DDL as well as cold starts on different function instances. */
export async function initializePostgres(pool: pg.Pool, sql: string) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SET LOCAL statement_timeout = '45s'");
    await connection.query("SET LOCAL idle_in_transaction_session_timeout = '50s'");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('owl-pilot-schema-v1'))");
    await connection.query(sql);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {}); throw error;
  } finally { connection.release(); }
}

/** One row per authority domain. All mutations commit before their result is released. */
export class PostgresJournal<T> {
  constructor(readonly pool: pg.Pool, readonly scope: string, readonly empty: () => T,
    readonly validate: (value: unknown) => asserts value is T) {}
  async init() {
    await initializePostgres(this.pool, `CREATE TABLE IF NOT EXISTS pilot_journals (
      scope TEXT PRIMARY KEY, data JSONB NOT NULL);`);
    await this.pool.query('INSERT INTO pilot_journals(scope,data) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [this.scope, JSON.stringify(this.empty())]);
  }
  async read(): Promise<T> {
    const value: unknown = (await this.pool.query('SELECT data FROM pilot_journals WHERE scope=$1', [this.scope])).rows[0]?.data;
    this.validate(value); return value;
  }
  async exclusive<R>(operation: (data: T) => Promise<R> | R): Promise<R> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL idle_in_transaction_session_timeout = '50s'");
      await connection.query("SET LOCAL statement_timeout = '45s'");
      const value: unknown = (await connection.query('SELECT data FROM pilot_journals WHERE scope=$1 FOR UPDATE', [this.scope])).rows[0]?.data;
      this.validate(value);
      const result = await operation(value);
      await connection.query('UPDATE pilot_journals SET data=$2 WHERE scope=$1', [this.scope, JSON.stringify(value)]);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {}); throw error;
    } finally { connection.release(); }
  }
}

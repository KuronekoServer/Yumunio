import { SqlSnapshotStore } from '@yumunio/prototype';

/** Validate explicit connection options before opening a pool; never log the returned credentials. */
export function validateDatabaseOptions({ dialect, connectionString, sslMode = 'verify-full', ca = '', connectionLimit = 5 } = {}) {
  const invalid = () => new Error('Invalid database configuration. Use an explicit supported URL, database name, and TLS settings.');
  if (!['mysql', 'postgres'].includes(dialect) || typeof connectionString !== 'string' || connectionString.length > 8192 || /[\u0000-\u0020]/.test(connectionString)) throw invalid();
  let url;
  try { url = new URL(connectionString); } catch { throw invalid(); }
  const protocols = dialect === 'mysql' ? ['mysql:', 'mariadb:'] : ['postgres:', 'postgresql:'];
  if (!protocols.includes(url.protocol) || !url.hostname || !url.username || url.search || url.hash || !url.pathname || url.pathname === '/') throw invalid();
  let user, password, database;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch { throw invalid(); }
  if (![user, password, database].every(value => !/[\u0000-\u001f\u007f]/.test(value)) || !user || !database || database.includes('/')) throw invalid();
  const port = url.port ? Number(url.port) : dialect === 'mysql' ? 3306 : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['verify-full', 'disable'].includes(sslMode)) throw invalid();
  if (typeof ca !== 'string' || ca.length > 65536 || (ca && (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----') || sslMode === 'disable'))) throw invalid();
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 50) throw invalid();
  // mysql2 does not pass an IP host to Node's TLS identity check. Require DNS for strict MySQL TLS.
  if (dialect === 'mysql' && sslMode === 'verify-full' && (url.hostname.includes(':') || /^[0-9.]+$/.test(url.hostname))) throw new Error('MySQL verify-full TLS requires a DNS hostname; use a matching certificate and DNS name.');
  return { dialect, host: url.hostname.replace(/^\[|\]$/g, ''), port, user, password, database, sslMode, ca, connectionLimit };
}

/** Node self-host bridge. MariaDB, TiDB and MySQL profiles share dialect mysql and a MySQL URL; PostgreSQL uses dialect postgres. Connections are lazy and queries use bound parameters. Profile selection is not live compatibility verification. */
export async function createDatabaseClient(options) {
  const config = validateDatabaseOptions(options);
  const ssl = config.sslMode === 'disable' ? undefined : { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) };
  if (config.dialect === 'mysql') {
    const { createPool } = await import('mysql2/promise');
    const pool = createPool({
      host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
      charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
      disableEval: true, waitForConnections: true, connectionLimit: config.connectionLimit,
      queueLimit: 32, connectTimeout: 10000, ...(ssl ? { ssl: { ...ssl, verifyIdentity: true } } : {})
    });
    return {
      dialect: 'mysql',
      database: pool, // Internal raw driver for the identity adapter; never serialize this resource.
      async query(sql, params = []) {
        const [result] = await pool.execute(sql, params);
        return Array.isArray(result) ? { rows: result, affectedRows: 0 } : { rows: [], affectedRows: result.affectedRows };
      },
      end: () => pool.end()
    };
  }
  const { Pool } = await import('pg');
  const pool = new Pool({
    host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
    ssl: ssl || false, max: config.connectionLimit, connectionTimeoutMillis: 10000,
    query_timeout: 10000, statement_timeout: 10000, allowExitOnIdle: true
  });
  // Checked-out query errors reject their promise. Idle disconnects must not become uncaught events.
  pool.on('error', () => {});
  return {
    dialect: 'postgres',
    database: pool, // Internal raw driver for the identity adapter.
    async query(sql, params = []) {
      const result = await pool.query(sql, params);
      return { rows: result.rows, affectedRows: result.rowCount ?? 0 };
    },
    end: () => pool.end()
  };
}

export async function createDatabaseSnapshotStore(options) {
  return new SqlSnapshotStore(await createDatabaseClient(options));
}

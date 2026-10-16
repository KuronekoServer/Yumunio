import { isValidAccessKey, validatePublicOrigin } from '../../packages/prototype/src/config.js';
import { validateDatabaseOptions } from '../../packages/adapters/src/database-snapshot.js';

/** Parse deployment configuration without opening filesystem or database connections. */
export function readServerConfig(env = {}) {
  const host = env.YUMUNIO_HOST || '127.0.0.1';
  const portText = env.YUMUNIO_PORT || '8788';
  if (typeof host !== 'string' || !host.trim() || host !== host.trim()) throw new Error('YUMUNIO_HOST must be a host name or address.');
  if (typeof portText !== 'string' || !/^\d+$/.test(portText)) throw new Error('YUMUNIO_PORT must be a valid port.');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('YUMUNIO_PORT must be a valid port.');
  const storage = env.YUMUNIO_STORAGE || 'browser-local';
  if (!['browser-local', 'sqlite', 'mariadb', 'tidb', 'mysql', 'postgres'].includes(storage)) throw new Error('YUMUNIO_STORAGE must be browser-local, sqlite, mariadb, tidb, mysql, or postgres.');
  const external = ['mariadb', 'tidb', 'mysql', 'postgres'].includes(storage);
  const accessKey = env.YUMUNIO_ACCESS_KEY || '';
  if (accessKey !== '' && !isValidAccessKey(accessKey)) throw new Error('YUMUNIO_ACCESS_KEY must contain 32 to 4096 characters.');
  const publicOrigin = validatePublicOrigin(env.YUMUNIO_PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
  const allowAnonymous = !external && ['127.0.0.1', 'localhost'].includes(host) && ['127.0.0.1', 'localhost'].includes(new URL(publicOrigin).hostname);
  if ((external || (storage === 'sqlite' && !allowAnonymous)) && !accessKey) throw new Error('Persistent external database or public hosting requires YUMUNIO_ACCESS_KEY.');
  const database = env.YUMUNIO_DATABASE || '.data/yumunio.sqlite';
  if (typeof database !== 'string' || !database.trim() || database.includes('\0')) throw new Error('YUMUNIO_DATABASE must be a file path.');
  const databaseOptions = external ? {
    dialect: storage === 'postgres' ? 'postgres' : 'mysql',
    connectionString: env.YUMUNIO_DATABASE_URL,
    sslMode: env.YUMUNIO_DATABASE_TLS || 'verify-full',
    ca: env.YUMUNIO_DATABASE_CA || ''
  } : null;
  if (external) validateDatabaseOptions(databaseOptions);
  return { host, port, storage, accessKey, publicOrigin, allowAnonymous, database, databaseOptions };
}

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function validateTestDatabaseUrl(value, dialect) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${dialect} test database URL.`); }
  const protocols = dialect === 'mysql' ? ['mysql:', 'mariadb:'] : ['postgres:', 'postgresql:'];
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) {
    throw new Error(`${dialect} integration tests require a literal loopback URL without query options.`);
  }
  let database;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error(`Invalid ${dialect} test database name.`); }
  if (!/^yumunio_test_[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`${dialect} integration tests require a dedicated yumunio_test_* database.`);
  }
  return { connectionString: url.href, database };
}

const main = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (main) {
  try {
    const options = [['mysql', process.env.YUMUNIO_TEST_MYSQL_URL], ['postgres', process.env.YUMUNIO_TEST_POSTGRES_URL]];
    if (!options.some(([, value]) => value)) throw new Error('Set YUMUNIO_TEST_MYSQL_URL and/or YUMUNIO_TEST_POSTGRES_URL to an explicitly disposable loopback yumunio_test_* database.');
    for (const [dialect, value] of options) if (value) validateTestDatabaseUrl(value, dialect);
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const testFiles = ['databases.mjs', 'identity-databases.mjs'].map(name => fileURLToPath(new URL('../../apps/server/integration/' + name, import.meta.url)));
    testFiles.push(fileURLToPath(new URL('../backup/integration/databases.mjs', import.meta.url)));
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
      cwd: root, env: process.env, windowsHide: true, stdio: 'inherit',
    });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

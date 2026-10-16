import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

test('the documented env-file startup runs a self-hosted SQLite service with private configuration', { timeout: 45000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'yumunio-env-start-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const accessKey = 'fixture-env-start-'.repeat(3);
  await writeFile(join(fixture, '.env'), ['YUMUNIO_STORAGE=sqlite', 'YUMUNIO_HOST=127.0.0.1', 'YUMUNIO_PORT=' + port, 'YUMUNIO_PUBLIC_ORIGIN=' + origin, 'YUMUNIO_DATABASE=.data/fixture.sqlite', 'YUMUNIO_ACCESS_KEY=' + accessKey].join('\n'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(YUMUNIO_|CLOUDFLARE_|CF_|WRANGLER_)/i.test(key)));
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', fileURLToPath(new URL('../server.mjs', import.meta.url))], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', spawnError;
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  child.once('error', error => { spawnError = error; });
  const ended = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && !spawnError) {
      child.kill('SIGTERM');
      if (await Promise.race([ended.then(() => true), delay(3000).then(() => false)]) === false) { child.kill('SIGKILL'); await ended; }
    }
    const target = await realpath(fixture);
    assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.match(basename(target), /^yumunio-env-start-/);
    await rm(target, { recursive: true, force: true });
  });
  let health, lastHealthError = null;
  const startedAt = performance.now();
  const deadline = startedAt + 30000;
  const diagnostic = () => JSON.stringify({
    elapsedMs: Math.round(performance.now() - startedAt),
    childAlive: child.exitCode === null && child.signalCode === null && !spawnError,
    exitCode: child.exitCode, signalCode: child.signalCode,
    lastHealthStatus: health?.status ?? null, lastError: lastHealthError,
    outputTail: output.split(accessKey).join('[REDACTED]').slice(-4000)
  });
  while (performance.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture startup failed: ' + diagnostic());
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      health = await fetch(origin + '/health', { signal: AbortSignal.timeout(Math.min(1000, remaining)) });
      lastHealthError = null;
      if (health.ok) break;
    } catch (error) {
      lastHealthError = { name: error.name, code: error.cause?.code ?? error.code ?? null };
    }
    await delay(Math.min(50, Math.max(0, deadline - performance.now())));
  }
  assert.ok(health?.ok, 'Fixture did not become ready: ' + diagnostic());
  assert.equal((await health.json()).storage, 'sqlite');
  assert.equal((await fetch(origin + '/api/workspace/snapshot')).status, 401);
  const login = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(origin + '/api/workspace/snapshot', { headers: { Cookie: cookie } })).json(), { revision: 0, snapshot: null });
  assert.ok(!output.includes(accessKey));
});

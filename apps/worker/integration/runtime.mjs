import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDemoWorkspace } from '../../web/public/store.js';
import { Y,fromBase64,toBase64,loadRoomDocument } from '@yumunio/collaboration';
import { assertNoPrivateJsonLiterals } from '../../../packages/identity/test/fixtures/assert-private-projection.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const runtimeServer = join(root, 'apps/worker/integration/serve.mjs');
const accessKey = 'local-runtime-fixture-' + 'A'.repeat(40);
const fixturePrefix = 'yumunio-worker-runtime-';
const runtimeFixtureRoot = join(root, '.build', 'worker-tests');
const authSecret = 'local-account-secret-' + 'C'.repeat(48);
const authPassword = 'Local-account-password-fixture-8642';
const relayToken = 'local-mail-relay-fixture-token';

async function freePort() {
  const listener = createServer();
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolveListen);
  });
  const port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function localEnvironment(directory) {
  const env = { ...process.env, CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: join(directory, 'wrangler.log'), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'CF_ACCOUNT_ID']) delete env[key];
  return env;
}

function command(args, directory) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], { cwd: root, env: localEnvironment(directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Local Wrangler command timed out.\n' + output)); }, 60000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(output);
      else reject(new Error(`Local Wrangler failed (${signal || code}).\n${output}`));
    });
  });
}

async function fixture(t, { database = false, key = accessKey, publicOrigin = true, accounts = false, authSchema = true, relay = null, oauthStart = false, blobs = null, collaborationChecks = false, isolatedAssets = false, apiTokens = undefined } = {}) {
  if (oauthStart && (!database || accounts !== 'closed' || relay)) throw new Error('OAuth-start fixture requires closed local D1 accounts without a relay.');
  await mkdir(runtimeFixtureRoot, { recursive: true });
  const directory = await mkdtemp(join(runtimeFixtureRoot, fixturePrefix));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const configPath = join(directory, 'wrangler.jsonc');
  const persistPath = join(directory, 'state');
  const template = database ? 'wrangler.d1.jsonc.example' : 'wrangler.jsonc';
  const config = JSON.parse(await readFile(join(root, 'apps/worker', template), 'utf8'));
  config.name = 'yumunio-runtime-fixture';
  config.main = join(root, 'apps/worker/worker.js');
  config.assets.directory = join(root, '.build/web');
  // The suite entry point builds once. Fixtures must only consume that checkpoint.
  delete config.build;
  if (isolatedAssets) {
    config.assets.directory = join(directory, 'assets');
    if (isolatedAssets === 'generated') await cp(join(root, '.build/web'), config.assets.directory, { recursive: true });
    else { await mkdir(config.assets.directory); await writeFile(join(config.assets.directory, 'index.html'), '<!doctype html><title>Synthetic backend fixture</title>', 'utf8'); }
  }
  config.vars = {};
  if (isolatedAssets === 'generated') Object.assign(config.vars, { YUMUNIO_AUTH_SECRET: authSecret, YUMUNIO_MAIL_HTTP_TOKEN: relayToken });
  if (database) {
    config.d1_databases = [{ binding: 'DB', database_name: 'yumunio-runtime-fixture', database_id: '00000000-0000-4000-8000-000000000001', remote: false }];
    if (key !== null) config.vars.YUMUNIO_ACCESS_KEY = key;
    if (publicOrigin) config.vars.YUMUNIO_PUBLIC_ORIGIN = origin;
  }
  if (accounts) {
    if (!database || !['closed', 'open'].includes(accounts)) throw new Error('Accounts fixture requires a local D1 binding and explicit mode.');
    Object.assign(config.vars, {
      YUMUNIO_ACCOUNTS_ENABLED: 'true', YUMUNIO_AUTH_SECRET: authSecret,
      YUMUNIO_REGISTRATION_MODE: accounts, YUMUNIO_MAIL_DRIVER: relay ? 'http' : 'disabled',
    });
    if (relay) {
      const target = new URL(relay.url);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/send' || !target.port || target.username || target.password || target.search || target.hash) throw new Error('Refusing non-loopback fixture mail relay.');
      config.vars.YUMUNIO_SMTP_FROM = 'no-reply@studio.example';
      config.vars.YUMUNIO_MAIL_HTTP_ENDPOINT = 'https://mail.fixture.invalid/send';
      config.vars.YUMUNIO_MAIL_HTTP_TOKEN = relayToken;
      const wrapper = join(directory, 'fixture-entry.mjs');
      const code = [
        'const originalFetch = globalThis.fetch.bind(globalThis);',
        'const relayTarget = ' + JSON.stringify(target.href) + ';',
        'const relayState = { calls: 0, statuses: [], failures: 0, categories: [], waitUntilCalls: 0 };',
        'globalThis.fetch = (input, init) => {',
        '  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;',
        '  if (url !== "https://mail.fixture.invalid/send") return originalFetch(input, init);',
        '  relayState.calls++;',
        '  const failed = error => { relayState.failures++; relayState.categories.push(/credentials/i.test(error?.message || "") ? "credentials" : /signal/i.test(error?.message || "") ? "signal" : "fetch"); throw new Error("Local fixture relay unavailable."); };',
        '  try { return originalFetch(typeof input === "object" && "url" in input ? new Request(relayTarget, input) : relayTarget, init).then(response => { relayState.statuses.push(response.status); return response; }, failed); } catch (error) { return failed(error); }',
        '};',
        'import baseWorker from ' + JSON.stringify(config.main.replaceAll('\\', '/')) + ';',
        'export default { fetch(request, env, context) {',
        '  const path = new URL(request.url).pathname;',
        '  if (path === "/api/__fixture/mail-status") return Response.json(relayState);',
        '  const forwardedContext = context && typeof context.waitUntil === "function" ? { waitUntil(task) { relayState.waitUntilCalls++; return context.waitUntil(task); } } : context;',
        '  return baseWorker.fetch(request, env, forwardedContext);',
        '} };',
      ].join('\n');
      await writeFile(wrapper, code, 'utf8');
      config.main = wrapper;
    }
  }
  if (oauthStart) {
    config.vars.YUMUNIO_OAUTH_GOOGLE_CLIENT_ID = 'local-workerd-google-fixture-client';
    config.vars.YUMUNIO_OAUTH_GOOGLE_CLIENT_SECRET = 'local-workerd-google-fixture-private-secret';
    const wrapper = join(directory, 'oauth-fixture-entry.mjs');
    const code = [
      'const oauthState = { externalAttempts: 0 };',
      'globalThis.fetch = () => { oauthState.externalAttempts++; throw new Error("External requests are forbidden in this local OAuth-start fixture."); };',
      'import baseWorker from ' + JSON.stringify(config.main.replaceAll('\\', '/')) + ';',
      'export default { fetch(request, env, context) {',
      '  if (new URL(request.url).pathname === "/api/__fixture/oauth-status") return Response.json(oauthState);',
      '  return baseWorker.fetch(request, env, context);',
      '} };',
    ].join('\n');
    await writeFile(wrapper, code, 'utf8');
    config.main = wrapper;
  }
  if (blobs) {
    if (blobs !== 'r2' || !database || !accounts) throw new Error('Blob fixture requires accounts and local D1/R2.');
    config.vars.YUMUNIO_BLOB_DRIVER = 'r2';
    config.r2_buckets = [{ binding: 'BLOBS', bucket_name: 'yumunio-runtime-fixture', remote: false }];
    const wrapper = join(directory, 'blob-fixture-entry.mjs');
    const code = [
      'import baseWorker from ' + JSON.stringify(config.main.replaceAll('\\', '/')) + ';',
      'export default { async fetch(request, env, context) {',
      '  if (new URL(request.url).pathname === "/api/__fixture/blob-status") { const result = await env.BLOBS.list({ limit: 1000 }); return Response.json({ objects: result.objects.length }); }',
      '  return baseWorker.fetch(request, env, context);',
      '} };',
    ].join('\n');
    await writeFile(wrapper, code, 'utf8'); config.main = wrapper;
  }
  if (collaborationChecks) {
    if (!database || !accounts) throw new Error('Collaboration guard fixture requires local D1 accounts.');
    const wrapper = join(directory, 'collaboration-fixture-entry.mjs');
    const code = [
      'import { createD1CollaborationStore } from ' + JSON.stringify(join(root, 'packages/identity/src/collaboration-store.js').replaceAll('\\', '/')) + ';',
      'import baseWorker from ' + JSON.stringify(config.main.replaceAll('\\', '/')) + ';',
      'export default { async fetch(request, env, context) {',
      '  if (new URL(request.url).pathname === "/api/__fixture/collaboration-rollback") {',
      '    const {workspaceId} = await request.json(); const store = createD1CollaborationStore(env.DB);',
      '    const before = await store.load(workspaceId); const title = before.payload.pages[0].page.title;',
      '    const changed = structuredClone(before.payload); changed.pages[0].page.title = "MUST ROLLBACK";',
      '    let code = "not-rejected"; try { await store.commit({workspaceId,expectedRevision:before.revision,payload:changed,membershipChange:{kind:"update",id:"missing-membership",accountId:"missing-account",previousRole:"member",role:"admin"}}); } catch (error) { code = error.code; }',
      '    const after = await store.load(workspaceId); const guards = await env.DB.prepare("SELECT COUNT(*) AS n FROM yumunio_transaction_guards").first();',
      '    return Response.json({code,beforeRevision:before.revision,afterRevision:after.revision,titlePreserved:after.payload.pages[0].page.title===title,guards:guards.n});',
      '  }',
      '  return baseWorker.fetch(request, env, context);',
      '} };',
    ].join('\n');
    await writeFile(wrapper, code, 'utf8'); config.main = wrapper;
  }
  if (apiTokens !== undefined) {
    config.vars.YUMUNIO_API_TOKENS_ENABLED=String(apiTokens);
    const wrapper=join(directory,'api-token-fixture-entry.mjs');
    const code=[
      'import baseWorker from '+JSON.stringify(config.main.replaceAll('\\','/'))+';',
      'const originalFetch=globalThis.fetch.bind(globalThis),meter={blocked:false,calls:0},generations=new Map(),grants=new Map();',
      'globalThis.fetch=(input,init)=>{const url=typeof input==="string"||input instanceof URL?String(input):input.url;if(url==="https://mail.fixture.invalid/send"&&meter.blocked){meter.calls++;return Promise.resolve(new Response("fixture delivery paused",{status:503}));}return originalFetch(input,init);};',
      'const valid=value=>typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);',
      'export default {async fetch(request,env,context){',
      'if(new URL(request.url).pathname==="/api/__fixture/api-token-control"){',
      'const data=await request.json();if(data.mode==="block-mail")meter.blocked=true;',
      'else if(data.mode==="due-mail"){meter.calls=0;await env.DB.prepare("UPDATE yumunio_mail_jobs SET status=\'queued\',available_at=\'2020-01-01T00:00:00.000Z\',lease_id=NULL,lease_until=NULL WHERE status=\'queued\'").run();}',
      'else if(data.mode==="sql-revoke"){if(!/^[a-f0-9]{32}$/.test(data.id))return new Response(null,{status:400});await env.DB.prepare("UPDATE yumunio_api_tokens SET revoked_at=?,active_slot=NULL,version=version+1 WHERE id=? AND revoked_at IS NULL").bind(new Date().toISOString(),data.id).run();}',
      'else if(["role-drop","role-restore","unverify","verify","replace-generation","restore-generation","deny-page","restore-page"].includes(data.mode)){',
      'if(!valid(data.accountId)||!valid(data.workspaceId))return new Response(null,{status:400});',
      'if(data.mode==="role-drop"||data.mode==="role-restore")await env.DB.prepare("UPDATE yumunio_memberships SET role=? WHERE userId=? AND organizationId=?").bind(data.mode==="role-drop"?"guest":"owner",data.accountId,data.workspaceId).run();',
      'if(data.mode==="unverify"||data.mode==="verify")await env.DB.prepare("UPDATE yumunio_users SET emailVerified=? WHERE id=?").bind(data.mode==="verify"?1:0,data.accountId).run();',
      'if(data.mode==="replace-generation"){const row=await env.DB.prepare("SELECT id FROM yumunio_memberships WHERE userId=? AND organizationId=?").bind(data.accountId,data.workspaceId).first();generations.set(data.accountId,row.id);await env.DB.prepare("UPDATE yumunio_memberships SET id=? WHERE userId=? AND organizationId=?").bind("fixture-new-"+data.accountId,data.accountId,data.workspaceId).run();}',
      'if(data.mode==="restore-generation")await env.DB.prepare("UPDATE yumunio_memberships SET id=? WHERE userId=? AND organizationId=?").bind(generations.get(data.accountId),data.accountId,data.workspaceId).run();',
      'if(data.mode==="deny-page"||data.mode==="restore-page"){const row=await env.DB.prepare("SELECT revision,payload_json FROM yumunio_account_content WHERE workspace_id=?").bind(data.workspaceId).first(),payload=JSON.parse(row.payload_json);if(data.mode==="deny-page"){grants.set(data.accountId,structuredClone(payload.grants));for(const grant of payload.grants)if(grant.accountId===data.accountId&&grant.pageId===data.pageId)grant.status="revoked";}else payload.grants=grants.get(data.accountId);await env.DB.prepare("UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=? AND revision=?").bind(JSON.stringify(payload),data.workspaceId,row.revision).run();}',
      '}else if(data.mode!=="meter")return new Response(null,{status:400});',
      'const queued=await env.DB.prepare("SELECT COUNT(*) AS n FROM yumunio_mail_jobs WHERE status=\'queued\'").first();return Response.json({calls:meter.calls,queued:queued.n});}',
      'return baseWorker.fetch(request,env,context);}};'
    ].join('\n');
    await writeFile(wrapper,code,'utf8');config.main=wrapper;
  }
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  let active;
  let stopping;
  let log = '';
  const exited = child => child.exitCode !== null || child.signalCode !== null;
  const waitForExit = (child, timeoutMs) => {
    if (exited(child)) return Promise.resolve(true);
    return new Promise(resolveExit => {
      const complete = result => { clearTimeout(timer); child.removeListener('exit', onExit); resolveExit(result); };
      const onExit = () => complete(true);
      const timer = setTimeout(() => complete(false), timeoutMs);
      child.once('exit', onExit);
      if (exited(child)) complete(true);
    });
  };
  const terminateOwnedTree = async child => {
    if (exited(child)) return;
    // Only this fixture's spawned PID/process group is eligible for forced cleanup.
    // Keep its reference until exit so a failed graceful stop cannot orphan IPC.
    if (process.platform === 'win32') {
      await new Promise((resolveKill, rejectKill) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => { killer.kill(); rejectKill(new Error('Owned Wrangler process-tree cleanup timed out.')); }, 5000);
        killer.once('error', error => { clearTimeout(timer); rejectKill(error); });
        killer.once('exit', code => { clearTimeout(timer); code === 0 || exited(child) ? resolveKill() : rejectKill(new Error('Owned Wrangler process-tree cleanup failed.')); });
      });
    } else {
      // Non-Windows children are spawned in a fixture-owned process group.
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const stop = async () => {
    if (stopping) return stopping;
    const child = active;
    if (!child || !Number.isSafeInteger(child.pid) || exited(child)) {
      if (active === child) active = undefined;
      return;
    }
    stopping = (async () => {
      let forced = false;
      if (child.connected) child.send({ type: 'stop' }, () => {});
      if (!await waitForExit(child, 10000)) {
        forced = true;
        await terminateOwnedTree(child);
        if (!await waitForExit(child, 5000)) throw new Error('Owned Wrangler test process did not exit after forced cleanup.');
      }
      if (active === child) active = undefined;
      if (forced) throw new Error('Owned Wrangler test process required forced cleanup after graceful stop timed out.');
    })();
    try { await stopping; } finally { stopping = undefined; }
  };
  t.after(async () => {
    await stop();
    const absolute = resolve(directory);
    const parent = resolve(runtimeFixtureRoot);
    const rel = relative(parent, absolute);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep) && !rel.includes(sep) && rel.startsWith(fixturePrefix)) await rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else throw new Error('Refusing cleanup outside the named runtime test directory.');
  });
  const start = async () => {
    log = '';
    const child = spawn(process.execPath, [runtimeServer, configPath, persistPath, String(port)],
      { cwd: root, env: localEnvironment(directory), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    active = child;
    child.stdout.on('data', chunk => { log = (log + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { log = (log + chunk).slice(-12000); });
    let launchError;
    child.once('error', error => { launchError = error; });
    try {
      const deadline = Date.now() + 75000;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (exited(child)) throw new Error('Wrangler exited before readiness.\n' + log);
        try {
          const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(1500) });
          const body = await response.json();
          if (body.runtime === 'worker' || body.error?.code === 'SERVER_CONFIGURATION') return;
        } catch {}
        await delay(100);
      }
      throw new Error('Local workerd HTTP server did not become ready.\n' + log);
    } catch (error) {
      try { await stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Local workerd startup failed and required cleanup.'); }
      throw error;
    }
  };
  if (database && key !== null && publicOrigin) {
    await command(['d1', 'execute', 'DB', '--local', '--config', configPath, '--persist-to', persistPath, '--file', join(root, 'apps/worker/snapshot-schema.sql')], directory);
    if (accounts && authSchema) await command(['d1', 'execute', 'DB', '--local', '--config', configPath, '--persist-to', persistPath, '--file', join(root, 'apps/worker/auth-schema.sql')], directory);
  }
  await start();
  const request = (pathname, { method = 'GET', body, cookie, headers = {}, binary = false } = {}) => fetch(origin + pathname, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  });
  const inspectD1 = async sql => {
    await stop();
    try {
      const output = await command(['d1', 'execute', 'DB', '--local', '--config', configPath, '--persist-to', persistPath, '--json', '--command', sql], directory);
      const result = JSON.parse(output);
      if (!Array.isArray(result) || result.some(item => item.success !== true)) throw new Error('Local D1 inspection failed.');
      return result[0].results;
    } finally { await start(); }
  };
  return { origin, request, inspectD1, restart: async () => { await stop(); await start(); },setApiTokens:async value=>{if(apiTokens===undefined)throw Error('API token fixture required.');await stop();config.vars.YUMUNIO_API_TOKENS_ENABLED=String(value);await writeFile(configPath,JSON.stringify(config,null,2),'utf8');await start();} };
}

async function login(f) {
  const response = await f.request('/api/session', { method: 'POST', body: { accessKey } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/api/);
  assert.doesNotMatch(header, /; Secure(?:;|$)/);
  return header.split(';')[0];
}

function checkPolicy(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
}

test('local workerd serves generated assets with security headers and preserves browser-local API boundaries', { timeout: 120000 }, async t => {
  const f = await fixture(t, { isolatedAssets: 'generated' });
  const health = await f.request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', runtime: 'worker', prototype: true, storage: 'browser-local' });
  assert.equal((await f.request('/health', { method: 'POST' })).status, 405);
  const home = await f.request('/');
  assert.equal(home.status, 200); checkPolicy(home);
  assert.equal(home.headers.get('location'), null);
  const homeText = await home.text(); assert.match(homeText, /<div id="app"><\/div>/);
  const index = await f.request('/index.html');
  assert.equal(index.status, 308); checkPolicy(index); assert.equal(index.headers.get('location'), '/notes');
  const workspace = await f.request('/workspace');
  assert.equal(workspace.status, 200); checkPolicy(workspace); assert.equal(workspace.headers.get('location'), null);
  const workspaceHtml=await workspace.text(),nextChunk=workspaceHtml.match(/<script[^>]+src="(\/_next\/static\/[^\"]+\.js)"/)?.[1];
  assert.ok(nextChunk,'the workspace serves its Next.js application scripts');
  const detail=await f.request('/workspace-detail?detail=1');assert.equal(detail.status,200);assert.match(detail.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.equal(detail.headers.get('cache-control'),'no-store');assert.equal(detail.headers.get('etag'),null);await detail.arrayBuffer();
  const workspaceScript=await f.request(nextChunk);assert.equal(workspaceScript.status,200);checkPolicy(workspaceScript);await workspaceScript.arrayBuffer();
  const legacy=await f.request('/workspace.html?workspace=preview');assert.equal(legacy.status,308);assert.equal(legacy.headers.get('location'),'/workspace?workspace=preview');
  assert.equal((await f.request('/unknown-page')).status, 404, 'unknown paths must not become HTML fallbacks');
  const script = await f.request('/sw.js'); assert.equal(script.status, 200);
  const precache = JSON.parse((await script.text()).match(/^const ASSETS=(\[.*\]);$/m)?.[1] ?? 'null');
  assert.ok(Array.isArray(precache) && precache.includes('/notes') && precache.includes('/offline'));
  for (const path of ['/notes','/install','/offline']) {
    assert.ok(precache.includes(path));
    const cached = await f.request(path);
    assert.equal(cached.status, 200, 'PWA HTML precache target must not redirect: '+path);
    assert.equal(cached.headers.get('location'), null, path);
    assert.match(cached.headers.get('content-type'), /text\/html/); await cached.arrayBuffer();
  }
  for (const name of ['/app.js', '/shared/snapshot.js']) {
    const asset = await f.request(name);
    assert.equal(asset.status, 200); checkPolicy(asset);
    assert.match(asset.headers.get('content-type'), /javascript/);
  }
  const specification = await f.request('/openapi.yaml');
  assert.equal(specification.status, 200); checkPolicy(specification);
  assert.equal(specification.headers.get('content-type'), 'application/yaml; charset=utf-8');
  assert.equal(specification.headers.get('set-cookie'), null);
  assert.equal(specification.headers.get('www-authenticate'), null);
  const specificationBytes = Buffer.from(await specification.arrayBuffer());
  assert.deepEqual(specificationBytes, await readFile(join(root, 'openapi.yaml')));
  for (const secret of [accessKey, authSecret, authPassword, relayToken]) assert.equal(specificationBytes.includes(Buffer.from(secret)), false);
  assert.equal((await f.request('/_headers')).status, 404);
  const capabilities = await f.request('/api/capabilities');
  assert.equal(capabilities.status, 200);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.storage, 'browser-local');
  assert.equal(capabilitiesBody.workspaceSync, false);
  assert.equal((await f.request('/api/workspace/snapshot')).status, 501);
  const missingApi = await f.request('/api/does-not-exist');
  assert.equal(missingApi.status, 501);
  assert.match(missingApi.headers.get('content-type'), /application\/json/);
});

test('local workerd and local D1 enforce sessions, CAS, origin checks, export, and persistence across restart', { timeout: 150000 }, async t => {
  const f = await fixture(t, { database: true });
  assert.equal((await f.request('/api/workspace/snapshot')).status, 401);
  assert.equal((await f.request('/api/workspace/export?format=native-json')).status, 401);
  const wrong = await f.request('/api/session', { method: 'POST', body: { accessKey: 'incorrect-fixture-key' } });
  assert.equal(wrong.status, 401);
  const cookie = await login(f);
  const empty = await f.request('/api/workspace/snapshot', { cookie });
  assert.deepEqual(await empty.json(), { revision: 0, snapshot: null });
  const snapshot = createDemoWorkspace();
  snapshot.name = 'Local runtime portability fixture';
  const saved = await f.request('/api/workspace/snapshot', { method: 'PUT', cookie, body: { expectedRevision: 0, snapshot } });
  assert.equal(saved.status, 200); checkPolicy(saved);
  assert.deepEqual(await saved.json(), { revision: 1, snapshot });
  const stale = await f.request('/api/workspace/snapshot', { method: 'PUT', cookie, body: { expectedRevision: 0, snapshot } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'VERSION_CONFLICT');
  const foreign = await f.request('/api/workspace/snapshot', { method: 'PUT', cookie, body: { expectedRevision: 1, snapshot }, headers: { Origin: 'https://foreign.example.invalid' } });
  assert.equal(foreign.status, 403);
  const native = await f.request('/api/workspace/export?format=native-json&includeTrash=false', { cookie });
  assert.equal(native.status, 200);
  assert.equal(native.headers.get('cache-control'), 'no-store');
  assert.match(native.headers.get('content-type'), /application\/json/);
  assert.match(JSON.stringify(await native.json()), /Local runtime portability fixture/);
  const archive = await f.request('/api/workspace/export?format=markdown-csv-zip&includeTrash=false', { cookie });
  assert.equal(archive.status, 200);
  assert.match(archive.headers.get('content-type'), /application\/zip/);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.ok(bytes.length > 22);
  await f.restart();
  const restored = await f.request('/api/workspace/snapshot', { cookie });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { revision: 1, snapshot });
});

for (const missing of ['key', 'origin']) {
  test(`local workerd fails closed when D1 is bound but its ${missing} is not configured`, { timeout: 120000 }, async t => {
    const f = await fixture(t, { database: true, ...(missing === 'key' ? { key: null } : { publicOrigin: false }) });
    assert.equal((await f.request('/health')).status, 503);
    const api = await f.request('/api/workspace/snapshot');
    assert.equal(api.status, 503);
    assert.equal((await api.json()).error.code, 'SERVER_CONFIGURATION');
  });
}

test('local workerd accounts read generated D1 auth schema and persist login rate counters in closed mode', { timeout: 180000 }, async t => {
  const f = await fixture(t, { database: true, accounts: 'closed' });
  const config = await f.request('/api/auth/config');
  assert.equal(config.status, 200); checkPolicy(config);
  assert.deepEqual(await config.json(), { enabled: true, registrationMode: 'closed', emailDelivery: false, workspaceContent: true, providers: [], oauthLinking: false });
  const session = await f.request('/api/auth/get-session');
  assert.equal(session.status, 200); assert.equal(await session.json(), null);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  const rejectedSignup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email: 'closed@studio.example', password: authPassword, name: 'Closed fixture' } });
  assert.ok([400, 403].includes(rejectedSignup.status)); await rejectedSignup.arrayBuffer();
  const legacyCookie = await login(f);
  const snapshot = createDemoWorkspace(); snapshot.name = 'Accounts preserve prototype notes';
  const saved = await f.request('/api/workspace/snapshot', { method: 'PUT', cookie: legacyCookie, body: { expectedRevision: 0, snapshot } });
  assert.equal(saved.status, 200); await saved.arrayBuffer();
  for (let attempt = 0; attempt < 5; attempt++) {
    const denied = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email: 'unknown@studio.example', password: authPassword }, headers: { 'x-yumunio-peer-ip': '198.51.100.' + attempt } });
    assert.equal(denied.status, 401); assert.equal((await denied.json()).error.code, 'ACCOUNT_REQUEST_FAILED');
  }
  const limited = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email: 'unknown@studio.example', password: authPassword } });
  assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
  const counters = await f.inspectD1('SELECT COUNT(*) AS total, MAX(count) AS maximum FROM yumunio_auth_rate_limits');
  assert.ok(counters[0].total >= 1); assert.ok(counters[0].maximum >= 5);
  const users = await f.inspectD1('SELECT COUNT(*) AS total FROM yumunio_users');
  assert.equal(users[0].total, 0);
  const afterRestart = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email: 'unknown@studio.example', password: authPassword } });
  assert.equal(afterRestart.status, 429); await afterRestart.arrayBuffer();
  const notes = await f.request('/api/workspace/snapshot', { cookie: legacyCookie });
  assert.deepEqual(await notes.json(), { revision: 1, snapshot });
});

test('local workerd account requests fail safely when the generated auth schema was not applied', { timeout: 120000 }, async t => {
  const f = await fixture(t, { database: true, accounts: 'closed', authSchema: false });
  const configured = await f.request('/api/auth/config');
  assert.equal(configured.status, 200); await configured.arrayBuffer();
  const unavailable = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email: 'missing-schema@studio.example', password: authPassword } });
  assert.equal(unavailable.status, 503);
  const body = await unavailable.text();
  assert.match(body, /ACCOUNT_(?:REQUEST_FAILED|UNAVAILABLE)/);
  assert.doesNotMatch(body, /D1_ERROR|no such table|sqlite|local-account-secret|Local-account-password/);
});

async function localMailRelay(t) {
  const messages = []; const failures = [];
  let status = 202;
  const server = createHttpServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/send' || request.headers.authorization !== 'Bearer ' + relayToken) {
        response.writeHead(403); response.end(); return;
      }
      const parts = []; let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 16384) throw new Error('Fixture relay body too large.');
        parts.push(part);
      }
      const message = JSON.parse(Buffer.concat(parts).toString('utf8'));
      assert.deepEqual(Object.keys(message).sort(), ['from', 'subject', 'text', 'to']);
      assert.equal(message.from, 'no-reply@studio.example');
      messages.push(message);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: status < 300 ? 'accepted' : 'unavailable' }));
    } catch {
      failures.push('Fixture relay rejected an unexpected request.');
      response.writeHead(500); response.end();
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  t.after(() => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())));
  return {
    url: `http://127.0.0.1:${server.address().port}/send`, messages,
    setStatus(value) { status = value; },
    async waitForCount(count) {
      const deadline = Date.now() + 10000;
      while (messages.length < count && !failures.length && Date.now() < deadline) await delay(50);
      assert.equal(failures.length, 0, 'Fixture relay request contract failed.');
      assert.ok(messages.length >= count, 'Fixture relay did not receive the expected message.');
      return messages[count - 1];
    },
  };
}

const accountCookies = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

test('local workerd open accounts verify through an owned mail relay, sign in, sign out and retain D1 rate limits', { timeout: 240000 }, async t => {
  const relay = await localMailRelay(t);
  const f = await fixture(t, { database: true, accounts: 'open', relay });

  const configured = await f.request('/api/auth/config');
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), { enabled: true, registrationMode: 'open', emailDelivery: true, workspaceContent: true, providers: [], oauthLinking: false });
  const email = 'verified-fixture@studio.example';
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: authPassword, name: 'Local fixture account' } });
  assert.equal(signup.status, 202); assert.deepEqual(await signup.json(), { status: 'request-received' });
  let mail;
  try { mail = await relay.waitForCount(1); }
  catch {
    const state = await (await f.request('/api/__fixture/mail-status')).json();
    const stored = await f.inspectD1('SELECT (SELECT COUNT(*) FROM yumunio_users) AS users, (SELECT COUNT(*) FROM yumunio_auth_accounts) AS accounts, (SELECT COUNT(*) FROM yumunio_auth_verifications) AS verifications');
    assert.fail('Fixture verification mail missing; storedCounts=' + JSON.stringify(stored[0]) + '; transportState=' + JSON.stringify(state));
  }
  assert.equal(mail.to, email);
  const link = new URL(mail.text.split('\n').at(-1));
  assert.equal(link.origin, f.origin); assert.equal(link.pathname, '/account');
  const token = link.searchParams.get('verify'); assert.ok(token);
  const unverified = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(unverified.status, 401); await unverified.arrayBuffer();
  assert.equal(relay.messages.length, 1);
  const invalidLink = await f.request('/api/auth/verify-email?token=invalid-fixture-token&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(invalidLink.status, 400); assert.equal((await invalidLink.json()).error.code, 'ACCOUNT_REQUEST_FAILED');
  const verified = await f.request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { status: 'email-verified' });
  const signin = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(signin.status, 200); checkPolicy(signin);
  const cookieHeader = signin.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i); assert.match(cookieHeader, /SameSite=Strict/i); assert.match(cookieHeader, /Path=\//i);
  assert.doesNotMatch(cookieHeader, /; Secure(?:;|$)/i);
  const cookie = accountCookies(signin); assert.match(cookie, /yumunio\.account/);
  const signedIn = await signin.json();
  assert.equal(signedIn.authenticated, true); assert.equal(signedIn.user.email, email); assert.equal(Object.hasOwn(signedIn, 'token'), false);
  const session = await f.request('/api/auth/get-session', { cookie });
  assert.equal(session.status, 200);
  const current = await session.json();
  assert.equal(current.user.email, email); assert.equal(current.user.emailVerified, true);
  assert.equal(Object.hasOwn(current.session, 'token'), false); assert.equal(Object.hasOwn(current.session, 'ipAddress'), false);
  assert.doesNotMatch(JSON.stringify(current), /Local-account-password-fixture/);
  const notes = await f.request('/api/workspace/snapshot', { cookie });
  assert.equal(notes.status, 401); await notes.arrayBuffer();
  const workspaceResponse = await f.request('/api/auth/organization/create', { method: 'POST', cookie, body: { name: 'D1 account pages', slug: 'd1-account-pages' } });
  assert.equal(workspaceResponse.status, 200);
  const workspace = await workspaceResponse.json();
  const contentPath = '/api/content/workspaces/' + workspace.id + '/pages';
  assert.equal((await f.request(contentPath)).status, 401);
  const pageResponse = await f.request(contentPath, { method: 'POST', cookie, body: { expectedRevision: 0, title: 'Private D1 page', blocks: [{ id: 'd1-block', type: 'paragraph', data: { text: 'D1 persisted body' } }] } });
  assert.equal(pageResponse.status, 201);
  const createdPage = await pageResponse.json();
  assert.equal(createdPage.revision, 1);
  const pagePath = contentPath + '/' + createdPage.page.id;
  const updatedPage = await f.request(pagePath, { method: 'PATCH', cookie, body: { expectedRevision: 1, expectedVersion: 1, title: 'Updated D1 page' } });
  assert.equal(updatedPage.status, 200); assert.equal((await updatedPage.json()).document.version, 2);
  const stalePage = await f.request(pagePath, { method: 'PATCH', cookie, body: { expectedRevision: 1, expectedVersion: 1, title: 'Stale' } });
  assert.equal(stalePage.status, 409); await stalePage.arrayBuffer();
  assert.equal((await f.request('/api/auth/organization/get-full-organization?organizationId=' + workspace.id, { cookie })).status, 404);
  const mailStateBeforeRestart = await (await f.request('/api/__fixture/mail-status')).json();
  await f.restart();
  const persistedPage = await f.request(pagePath, { cookie });
  assert.equal(persistedPage.status, 200);
  const persisted = await persistedPage.json();
  assert.equal(persisted.revision, 2); assert.equal(persisted.page.title, 'Updated D1 page');
  assert.equal(persisted.document.blocks[0].data.text, 'D1 persisted body');
  const signout = await f.request('/api/auth/sign-out', { method: 'POST', cookie, body: {} });
  assert.equal(signout.status, 200); await signout.arrayBuffer();
  const revoked = await f.request('/api/auth/get-session', { cookie });
  assert.equal(await revoked.json(), null);
  assert.equal((await f.request(pagePath, { cookie })).status, 401);
  relay.setStatus(503);
  for (const requestedEmail of [email, 'unknown-reset@studio.example']) {
    const reset = await f.request('/api/auth/request-password-reset', { method: 'POST', body: { email: requestedEmail, redirectTo: f.origin + '/account' } });
    assert.equal(reset.status, 202); assert.deepEqual(await reset.json(), { status: 'request-received' });
  }
  const resetMail = await relay.waitForCount(2);
  assert.equal(resetMail.to, email);
  assert.ok(new URL(resetMail.text.split('\n').at(-1)).searchParams.has('reset'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const wrong = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: 'Wrong-fixture-password-8642' } });
    assert.equal(wrong.status, 401); await wrong.arrayBuffer();
  }
  const limited = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(limited.status, 429); await limited.arrayBuffer();
  const relayState = await (await f.request('/api/__fixture/mail-status')).json();
  assert.equal(mailStateBeforeRestart.calls + relayState.calls, 2);
  assert.deepEqual([...mailStateBeforeRestart.statuses, ...relayState.statuses], [202, 503]);
  assert.equal(mailStateBeforeRestart.failures + relayState.failures, 0);
  assert.ok(mailStateBeforeRestart.waitUntilCalls + relayState.waitUntilCalls >= 2);
  const stored = await f.inspectD1('SELECT emailVerified FROM yumunio_users');
  assert.deepEqual(stored, [{ emailVerified: 1 }]);
  const stillRevoked = await f.request('/api/auth/get-session', { cookie });
  assert.equal(await stillRevoked.json(), null);
  const stillLimited = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(stillLimited.status, 429); await stillLimited.arrayBuffer();
});

test('local workerd OAuth start uses PKCE and D1 state while external requests stay forbidden', { timeout: 150000 }, async t => {
  const f = await fixture(t, { database: true, accounts: 'closed', oauthStart: true });
  const configured = await f.request('/api/auth/config');
  assert.equal(configured.status, 200); checkPolicy(configured);
  const config = await configured.json();
  assert.deepEqual(config, { enabled: true, registrationMode: 'closed', emailDelivery: false, workspaceContent: true,
    providers: [{ id: 'google', label: 'Google', type: 'oidc' }], oauthLinking: false });
  assert.doesNotMatch(JSON.stringify(config), /local-workerd-google|clientSecret|issuer|fixture-private-secret/);
  const start = await f.request('/api/auth/sign-in/social', { method: 'POST', body: { provider: 'google', callbackURL: '/account' } });
  assert.equal(start.status, 200); checkPolicy(start);
  const started = await start.json();
  assert.deepEqual(Object.keys(started), ['url', 'redirect']); assert.equal(started.redirect, false);
  const authorization = new URL(started.url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('client_id'), 'local-workerd-google-fixture-client');
  assert.equal(authorization.searchParams.get('redirect_uri'), f.origin + '/api/auth/callback/google');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(authorization.searchParams.get('state')); assert.ok(authorization.searchParams.get('nonce'));
  assert.ok(authorization.searchParams.get('scope').split(' ').includes('openid'));
  assert.doesNotMatch(started.url, /fixture-private-secret|client_secret/);
  const stateCookie = start.headers.getSetCookie().find(value => value.includes('yumunio.account.state='));
  assert.ok(stateCookie); assert.match(stateCookie, /HttpOnly/i); assert.match(stateCookie, /SameSite=Lax/i);
  assert.doesNotMatch(stateCookie, /; Secure(?:;|$)/i);
  const cookie = accountCookies(start);
  const assertNoExternalRequests = async () => {
    const status = await f.request('/api/__fixture/oauth-status');
    assert.equal(status.status, 200); assert.deepEqual(await status.json(), { externalAttempts: 0 });
  };
  await assertNoExternalRequests();
  const beforeCallbacks = await f.inspectD1('SELECT (SELECT COUNT(*) FROM yumunio_auth_verifications) AS states, (SELECT COUNT(*) FROM yumunio_users) AS users, (SELECT COUNT(*) FROM yumunio_auth_sessions) AS sessions, (SELECT COUNT(*) FROM yumunio_auth_accounts) AS accounts');
  assert.deepEqual(beforeCallbacks, [{ states: 1, users: 0, sessions: 0, accounts: 0 }]);
  const bogus = await f.request('/api/auth/callback/google?code=fixture-code&state=invalid-fixture-state', { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(bogus.status, 302);
  assert.equal(bogus.headers.get('location'), f.origin + '/account?oauth=error');
  assert.equal(await bogus.text(), '');
  const deniedQuery = new URLSearchParams({ state: authorization.searchParams.get('state'), error: 'access_denied', error_description: 'Private provider fixture details' });
  const denied = await f.request('/api/auth/callback/google?' + deniedQuery, { cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get('location'), f.origin + '/account?oauth=error');
  assert.equal(denied.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await denied.text(), '');
  const session = await f.request('/api/auth/get-session');
  assert.equal(session.status, 200); assert.equal(await session.json(), null);
  await assertNoExternalRequests();
  const afterCallbacks = await f.inspectD1('SELECT (SELECT COUNT(*) FROM yumunio_auth_verifications) AS states, (SELECT COUNT(*) FROM yumunio_users) AS users, (SELECT COUNT(*) FROM yumunio_auth_sessions) AS sessions, (SELECT COUNT(*) FROM yumunio_auth_accounts) AS accounts');
  assert.deepEqual(afterCallbacks, [{ states: 0, users: 0, sessions: 0, accounts: 0 }]);
  await assertNoExternalRequests();
});

test('local workerd imports a private page bundle atomically and replays the D1 receipt after restart', { timeout: 180000 }, async t => {
  const relay = await localMailRelay(t);
  const f = await fixture(t, { database: true, accounts: 'open', relay });
  const email = 'd1-import-fixture@studio.example';
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: authPassword, name: 'Local D1 import fixture' } });
  assert.equal(signup.status, 202); await signup.arrayBuffer();
  const mail = await relay.waitForCount(1);
  const token = new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');
  const verified = await f.request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(verified.status, 200); await verified.arrayBuffer();
  const signin = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(signin.status, 200); const cookie = accountCookies(signin); const signedIn = await signin.json();
  const expectedHeaders = { 'X-Yumunio-Expected-Account': signedIn.user.id };
  const organization = await f.request('/api/auth/organization/create', { method: 'POST', cookie, headers: expectedHeaders, body: { name: 'D1 atomic import', slug: 'd1-atomic-import' } });
  assert.equal(organization.status, 200); const workspace = await organization.json();
  const base = '/api/content/workspaces/' + workspace.id;
  const bundle = { expectedRevision: 0, importId: 'local-d1-import-fixture', pages: [
    { sourceId: 'source-folder', parentSourceId: null, title: 'Imported D1 folder', blocks: [] },
    { sourceId: 'source-page', parentSourceId: 'source-folder', title: 'Imported D1 page', blocks: [{ id: 'source-paragraph', type: 'paragraph', data: { text: 'Atomically imported body' } }] },
  ] };
  const staleBefore = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: { ...bundle, expectedRevision: 1 } });
  assert.equal(staleBefore.status, 409); await staleBefore.arrayBuffer();
  const empty = await f.request(base + '/pages', { cookie });
  assert.deepEqual((await empty.json()).pages, []);
  const requests = await Promise.all([f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle }), f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle })]);
  assert.deepEqual(requests.map(response => response.status).sort(), [200, 201]);
  const responses = await Promise.all(requests.map(response => response.json()));
  const created = responses.find(response => response.replayed === false);
  const replayed = responses.find(response => response.replayed === true);
  assert.deepEqual(replayed, { ...created, replayed: true });
  assert.equal(created.revision, 1); assert.equal(created.pageCount, 2); assert.equal(created.importId, bundle.importId);
  const listResponse = await f.request(base + '/pages', { cookie });
  assert.equal(listResponse.status, 200); const list = await listResponse.json();
  assert.equal(list.pages.length, 2); assert.equal(list.revision, 1);
  for (const key of ['imports', 'payload', 'grants', 'principals']) assert.equal(Object.hasOwn(list, key), false);
  const rootPage = list.pages.find(page => page.id === created.rootPageId);
  assert.equal(rootPage.parentId, null); assert.ok(rootPage.capabilities.includes('manage'));
  const child = list.pages.find(page => page.parentId === rootPage.id); assert.ok(child);
  assert.notEqual(child.id, 'source-page');
  const childResponse = await f.request(base + '/pages/' + child.id, { cookie });
  assert.equal(childResponse.status, 200); const saved = await childResponse.json();
  assert.equal(saved.document.blocks[0].data.text, 'Atomically imported body');
  assert.notEqual(saved.document.blocks[0].id, 'source-paragraph');
  const changed = structuredClone(bundle); changed.pages[1].title = 'Changed retry body';
  const conflict = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: changed });
  assert.equal(conflict.status, 409); await conflict.arrayBuffer();
  const invalid = structuredClone(bundle); invalid.importId = 'invalid-second-import'; invalid.expectedRevision = 1; invalid.pages[1].parentSourceId = rootPage.id;
  const rejected = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: invalid });
  assert.equal(rejected.status, 400); await rejected.arrayBuffer();
  await f.restart();
  const afterRestart = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle });
  assert.equal(afterRestart.status, 200); assert.deepEqual(await afterRestart.json(), { ...created, replayed: true });
  const counts = await f.inspectD1("SELECT revision, json_array_length(json_extract(payload_json, '$.pages')) AS pages, json_array_length(json_extract(payload_json, '$.grants')) AS grants, json_array_length(json_extract(payload_json, '$.imports')) AS receipts FROM yumunio_account_content");
  assert.deepEqual(counts, [{ revision: 1, pages: 2, grants: 1, receipts: 1 }]);
  const logout = await f.request('/api/auth/sign-out', { method: 'POST', cookie, headers: expectedHeaders, body: {} });
  assert.equal(logout.status, 200); await logout.arrayBuffer();
  const unauthenticated = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle });
  assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
});

test('local workerd imports native CSV collections and internal links in one D1 CAS and preserves edited source values after restart', { timeout: 180000 }, async t => {
  const relay = await localMailRelay(t);
  const f = await fixture(t, { database: true, accounts: 'open', relay });
  const email = 'd1-native-csv-fixture@studio.example';
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: authPassword, name: 'Local native CSV fixture' } });
  assert.equal(signup.status, 202); await signup.arrayBuffer();
  const mail = await relay.waitForCount(1); const token = new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');
  const verified = await f.request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(verified.status, 200); await verified.arrayBuffer();
  const signin = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(signin.status, 200); const cookie = accountCookies(signin); const identity = await signin.json();
  const expectedHeaders = { 'X-Yumunio-Expected-Account': identity.user.id };
  const organization = await f.request('/api/auth/organization/create', { method: 'POST', cookie, body: { name: 'D1 native CSV', slug: 'd1-native-csv' } });
  assert.equal(organization.status, 200); const workspace = await organization.json(); const base = '/api/content/workspaces/' + workspace.id;
  const bundle = { expectedRevision: 0, importId: 'local-d1-native-csv', pages: [
    { sourceId: 'folder', parentSourceId: null, title: 'Native CSV folder', blocks: [] },
    { sourceId: 'csv', parentSourceId: 'folder', title: 'Imported CSV', blocks: [] },
    { sourceId: 'row', parentSourceId: 'csv', title: 'Imported CSV row', blocks: [] },
    { sourceId: 'doc', parentSourceId: 'folder', title: 'Linked document', blocks: [{ id: 'link-block', type: 'paragraph', data: { text: 'Open CSV', links: [{ start: 5, end: 8, label: 'CSV', sourceCollectionId: 'collection-source' }] } }] },
  ], collections: [{ sourceId: 'collection-source', pageSourceId: 'csv', properties: [{ id: 'property-source', name: 'Code', type: 'text', sourceName: 'Original code' }],
    records: [{ sourceId: 'record-source', pageSourceId: 'row', values: { 'property-source': '001 日本語 😀' } }] }] };
  const responses = await Promise.all([f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle }), f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const committed = await Promise.all(responses.map(response => response.json()));
  const first = committed.find(result => result.replayed === false); assert.equal(first.pageCount, 4); assert.equal(first.revision, 1);
  assert.deepEqual(committed.find(result => result.replayed === true), { ...first, replayed: true });
  const listed = await (await f.request(base + '/pages', { cookie })).json();
  const container = listed.pages.find(page => page.title === 'Imported CSV'); assert.ok(container.collectionId);
  const collectionPath = base + '/collections/' + container.collectionId;
  const get = await f.request(collectionPath, { cookie }); assert.equal(get.status, 200); const collection = (await get.json()).collection;
  const propertyId = collection.properties[0].id; const row = collection.records[0];
  assert.notEqual(propertyId, 'property-source'); assert.notEqual(row.id, 'record-source');
  assert.equal(row.values[propertyId], '001 日本語 😀'); assert.equal(row.sourceValues[propertyId], '001 日本語 😀');
  assert.deepEqual(collection.sourceHeaders, ['Original code']);
  const doc = listed.pages.find(page => page.title === 'Linked document');
  const linked = await (await f.request(base + '/pages/' + doc.id, { cookie })).json();
  assert.deepEqual(linked.document.blocks[0].data.links, [{ start: 5, end: 8, label: 'CSV', pageId: container.id }]);
  const patch = await f.request(collectionPath + '/records/' + row.id, { method: 'PATCH', cookie, headers:expectedHeaders, body: { expectedRevision: 1, values: { [propertyId]: 'Edited cell' } } });
  assert.equal(patch.status, 200); const edited = await patch.json(); assert.equal(edited.revision, 2);
  assert.equal(edited.record.values[propertyId], 'Edited cell'); assert.equal(edited.record.sourceValues[propertyId], '001 日本語 😀');
  const stale = await f.request(collectionPath + '/records/' + row.id, { method: 'PATCH', cookie, headers:expectedHeaders, body: { expectedRevision: 1, values: { [propertyId]: 'Stale cell' } } });
  assert.equal(stale.status, 409); await stale.arrayBuffer();
  const modified = structuredClone(bundle); modified.collections[0].records[0].values['property-source'] = 'Changed retry';
  const conflict = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: modified });
  assert.equal(conflict.status, 409); await conflict.arrayBuffer();
  await f.restart();
  const persisted = await (await f.request(collectionPath, { cookie })).json(); assert.equal(persisted.revision, 2);
  assert.equal(persisted.collection.records[0].values[propertyId], 'Edited cell'); assert.equal(persisted.collection.records[0].sourceValues[propertyId], '001 日本語 😀');
  const replay = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { ...first, replayed: true });
  const counts = await f.inspectD1("SELECT revision, json_array_length(json_extract(payload_json, '$.collections')) AS collections, json_array_length(json_extract(payload_json, '$.pages')) AS pages FROM yumunio_account_content");
  assert.deepEqual(counts, [{ revision: 2, collections: 1, pages: 4 }]);
});
test('local workerd stages immutable R2 attachments, cancels fenced reservations and commits page ACL bindings with D1 across restart', { timeout: 180000 }, async t => {
  const relay = await localMailRelay(t);
  const f = await fixture(t, { database: true, accounts: 'open', relay, blobs: 'r2' });
  const email = 'd1-r2-attachment-fixture@studio.example';
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: authPassword, name: 'Local attachment fixture' } });
  assert.equal(signup.status, 202); await signup.arrayBuffer();
  const mail = await relay.waitForCount(1); const token = new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');
  const verified = await f.request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(verified.status, 200); await verified.arrayBuffer();
  const signin = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(signin.status, 200); const cookie = accountCookies(signin); const identity = await signin.json();
  const expectedHeaders = { 'X-Yumunio-Expected-Account': identity.user.id };
  const organization = await f.request('/api/auth/organization/create', { method: 'POST', cookie, body: { name: 'D1 R2 attachments', slug: 'd1-r2-attachments' } });
  assert.equal(organization.status, 200); const workspace = await organization.json(); const base = '/api/content/workspaces/' + workspace.id;
  const assetBase = base + '/imports/r2-import/assets'; const bytes = new TextEncoder().encode('Private R2 bytes 日本語 😀');
  const checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const meta = { expectedRevision: 0, sourceId: 'source-file', name: '日本語.txt', mediaType: 'application/octet-stream', size: bytes.length, checksum };
  const reserve = await f.request(assetBase, { method: 'POST', cookie, headers: expectedHeaders, body: meta });
  assert.equal(reserve.status, 201); const reserved = await reserve.json(); assert.equal(reserved.revision, 1); assert.equal(reserved.status, 'reserved');
  assert.deepEqual(await (await f.request('/api/__fixture/blob-status')).json(), { objects: 0 });
  const put = await f.request(assetBase + '/' + reserved.assetId, { method: 'PUT', cookie, binary: true, headers: { ...expectedHeaders, 'X-Yumunio-Expected-Revision': '1' }, body: bytes });
  assert.equal(put.status, 200); assert.deepEqual(await put.json(), { revision: 2, assetId: reserved.assetId, status: 'ready' });
  assert.deepEqual(await (await f.request('/api/__fixture/blob-status')).json(), { objects: 1 });
  const cancelled = await f.request(assetBase + '/' + reserved.assetId, { method: 'DELETE', cookie, headers: expectedHeaders, body: { expectedRevision: 2 } });
  assert.equal(cancelled.status, 200); assert.deepEqual(await cancelled.json(), { revision: 4, removed: true });
  assert.deepEqual(await (await f.request('/api/__fixture/blob-status')).json(), { objects: 0 });
  const reservedAgain = await f.request(assetBase, { method: 'POST', cookie, headers: expectedHeaders, body: { ...meta, expectedRevision: 4 } });
  assert.equal(reservedAgain.status, 201); const active = await reservedAgain.json(); assert.equal(active.revision, 5); assert.notEqual(active.assetId, reserved.assetId);
  const uploaded = await f.request(assetBase + '/' + active.assetId, { method: 'PUT', cookie, binary: true, headers: { ...expectedHeaders, 'X-Yumunio-Expected-Revision': '5' }, body: bytes });
  assert.equal(uploaded.status, 200); assert.equal((await uploaded.json()).revision, 6);
  const staged = await (await f.request(assetBase, { cookie, headers: expectedHeaders })).json();
  assert.equal(staged.assets.length, 1); assert.equal(staged.assets[0].status, 'ready'); assert.equal(staged.assets[0].checksum, checksum);
  assert.doesNotMatch(JSON.stringify(staged), /objectKey|profileId|objects\/|accountId|membershipId/);
  const bundle = { expectedRevision: 6, importId: 'r2-import', pages: [
    { sourceId: 'folder', parentSourceId: null, title: 'Attachment folder', blocks: [] },
    { sourceId: 'page', parentSourceId: 'folder', title: 'Attachment page', blocks: [{ id: 'link-source', type: 'paragraph', data: { text: 'Open file', links: [{ start: 5, end: 9, label: 'file', sourceAssetId: 'source-file' }] } }] },
  ], assets: [{ sourceId: 'source-file', assetId: active.assetId, pageSourceIds: ['folder', 'page'] }] };
  const imported = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle });
  assert.equal(imported.status, 201); const receipt = await imported.json(); assert.equal(receipt.revision, 7);
  const listed = await (await f.request(base + '/pages', { cookie })).json(); const page = listed.pages.find(item => item.title === 'Attachment page');
  const pageData = await (await f.request(base + '/pages/' + page.id, { cookie })).json(); const attachment = pageData.attachments[0];
  assert.deepEqual(pageData.document.blocks[0].data.links, [{ start: 5, end: 9, label: 'file', pageId: page.id, attachmentId: attachment.id }]);
  const downloadPath = base + '/pages/' + page.id + '/attachments/' + attachment.id;
  const download = await f.request(downloadPath, { cookie }); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  const unauthenticated = await f.request(downloadPath); assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
  await f.restart();
  const persisted = await f.request(downloadPath, { cookie }); assert.equal(persisted.status, 200); assert.deepEqual(new Uint8Array(await persisted.arrayBuffer()), bytes);
  const replay = await f.request(base + '/imports', { method: 'POST', cookie, headers: expectedHeaders, body: bundle }); assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...receipt, replayed: true });
  assert.deepEqual(await (await f.request('/api/__fixture/blob-status')).json(), { objects: 1 });
  const counts = await f.inspectD1("SELECT revision, json_array_length(json_extract(payload_json, '$.attachments')) AS attachments, json_array_length(json_extract(payload_json, '$.pendingBlobs')) AS pending FROM yumunio_account_content");
  assert.deepEqual(counts, [{ revision: 7, attachments: 2, pending: 0 }]);
});
test('local workerd moves, trashes, restores and searches account pages with readable JSON and ZIP export across D1 restart', { timeout: 180000 }, async t => {
  const relay = await localMailRelay(t);
  const f = await fixture(t, { database: true, accounts: 'open', relay });
  const email = 'd1-page-lifecycle-fixture@studio.example';
  const signup = await f.request('/api/auth/sign-up/email', { method: 'POST', body: { email, password: authPassword, name: 'Local page lifecycle fixture' } });
  assert.equal(signup.status, 202); await signup.arrayBuffer();
  const mail = await relay.waitForCount(1); const token = new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');
  const verified = await f.request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(f.origin + '/account'));
  assert.equal(verified.status, 200); await verified.arrayBuffer();
  const signin = await f.request('/api/auth/sign-in/email', { method: 'POST', body: { email, password: authPassword } });
  assert.equal(signin.status, 200); const cookie = accountCookies(signin); const identity = await signin.json();
  const expectedHeaders = { 'X-Yumunio-Expected-Account': identity.user.id };
  const organization = await f.request('/api/auth/organization/create', { method: 'POST', cookie, body: { name: 'D1 page lifecycle', slug: 'd1-page-lifecycle' } });
  assert.equal(organization.status, 200); const workspace = await organization.json(); const base = '/api/content/workspaces/' + workspace.id;
  const created = await f.request(base + '/pages', { method: 'POST', cookie, body: { expectedRevision: 0, title: 'D1 source folder' } });
  assert.equal(created.status, 201); const rootPage = (await created.json()).page;
  const childResponse = await f.request(base + '/pages', { method: 'POST', cookie, body: { expectedRevision: 1, parentId: rootPage.id, title: '東京 child', blocks: [{ id: 'lifecycle-block', type: 'paragraph', data: { text: 'Searchable 東京 body' } }] } });
  assert.equal(childResponse.status, 201); const child = (await childResponse.json()).page;
  const destinationResponse = await f.request(base + '/pages', { method: 'POST', cookie, body: { expectedRevision: 2, title: 'D1 destination' } });
  assert.equal(destinationResponse.status, 201); const destination = (await destinationResponse.json()).page;
  const moved = await f.request(base + '/pages/' + rootPage.id + '/location', { method: 'PATCH', cookie, headers: expectedHeaders, body: { expectedRevision: 3, parentId: destination.id } });
  assert.equal(moved.status, 200); assert.deepEqual(await moved.json(), { revision: 4, pageId: rootPage.id, affectedPageCount: 2 });
  const searchPath = base + '/search?q=' + encodeURIComponent('東京');
  const search = await f.request(searchPath, { cookie }); assert.equal(search.status, 200); const results = await search.json(); assert.equal(results.results.length, 1); assert.equal(results.results[0].page.id, child.id);
  const exported = await f.request(base + '/export?format=json', { cookie }); assert.equal(exported.status, 200); const exportData = await exported.json(); assert.equal(exportData.pages.length, 3); assert.match(exportData.warnings.join(' '), /manifest only.*not a full backup/);
  const trashed = await f.request(base + '/pages/' + rootPage.id, { method: 'DELETE', cookie, headers: expectedHeaders, body: { expectedRevision: 4 } });
  assert.equal(trashed.status, 200); assert.deepEqual(await trashed.json(), { revision: 5, pageId: rootPage.id, affectedPageCount: 2 });
  const unavailable = await f.request(base + '/pages/' + child.id, { cookie }); assert.equal(unavailable.status, 404); await unavailable.arrayBuffer();
  assert.deepEqual((await (await f.request(searchPath, { cookie })).json()).results, []);
  const trash = await (await f.request(base + '/trash', { cookie })).json(); assert.equal(trash.pages.length, 1); assert.equal(trash.pages[0].id, rootPage.id); assert.equal(trash.pages[0].pageCount, 2);
  const restored = await f.request(base + '/pages/' + rootPage.id + '/restore', { method: 'POST', cookie, headers: expectedHeaders, body: { expectedRevision: 5 } });
  assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), { revision: 6, pageId: rootPage.id, affectedPageCount: 2 });
  const stale = await f.request(base + '/pages/' + child.id, { method: 'PATCH', cookie, body: { expectedRevision: 6, expectedVersion: 1, title: 'Stale old edit' } });
  assert.equal(stale.status, 409); await stale.arrayBuffer();
  const zip = await f.request(base + '/export?format=zip', { cookie }); assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip'); assert.match(zip.headers.get('content-disposition'), /attachment/);
  const archive = new Uint8Array(await zip.arrayBuffer()); assert.deepEqual([...archive.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]); assert.ok(new TextDecoder().decode(archive).includes('content.json'));
  await f.restart();
  const persisted = await (await f.request(base + '/pages/' + child.id, { cookie })).json(); assert.equal(persisted.document.version, 4); assert.equal(persisted.page.title, '東京 child'); assert.equal(persisted.revision, 6);
  const targetDocument = await (await f.request(base + '/pages/' + destination.id, { cookie })).json();
  const blockMove = { expectedRevision: 6, expectedVersion: persisted.document.version, targetPageId: destination.id, targetExpectedVersion: targetDocument.document.version,
    blockId: persisted.document.blocks[0].id, parentBlockId: null, index: 0 };
  const movedBlock = await f.request(base + '/pages/' + child.id + '/blocks/move', { method: 'POST', cookie, headers: expectedHeaders, body: blockMove });
  assert.equal(movedBlock.status, 200); assert.deepEqual(await movedBlock.json(), { revision: 7, blockId: blockMove.blockId, sourcePageId: child.id, targetPageId: destination.id, sourceVersion: 5, targetVersion: 2 });
  const replayBlock = await f.request(base + '/pages/' + child.id + '/blocks/move', { method: 'POST', cookie, headers: expectedHeaders, body: blockMove });
  assert.equal(replayBlock.status, 409); await replayBlock.arrayBuffer();
  await f.restart();
  const sourceAfterMove = await (await f.request(base + '/pages/' + child.id, { cookie })).json();
  const targetAfterMove = await (await f.request(base + '/pages/' + destination.id, { cookie })).json();
  assert.deepEqual(sourceAfterMove.document.blocks, []); assert.equal(targetAfterMove.document.blocks[0].id, blockMove.blockId);
  assert.equal(targetAfterMove.document.blocks[0].data.text, 'Searchable 東京 body'); assert.equal(targetAfterMove.revision, 7);
  assert.deepEqual((await (await f.request(base + '/trash', { cookie })).json()).pages, []);
  const duplicates = await f.request(base + '/search?q=x&q=y', { cookie }); assert.equal(duplicates.status, 400); await duplicates.arrayBuffer();
  const counts = await f.inspectD1("SELECT revision, json_array_length(json_extract(payload_json, '$.trashGroups')) AS groups FROM yumunio_account_content"); assert.deepEqual(counts, [{ revision: 7, groups: 0 }]);
  const signout = await f.request('/api/auth/sign-out', { method: 'POST', cookie, body: {} }); assert.equal(signout.status, 200); await signout.arrayBuffer();
  const deniedExport = await f.request(base + '/export?format=json', { cookie }); assert.equal(deniedExport.status, 401); await deniedExport.arrayBuffer();
});


test('local workerd consumes guest invitations with atomic D1 guards and preserves last workspace and page managers', { timeout: 240000 }, async t => {
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,collaborationChecks:true});
  async function register(name,count){
    const email='d1-collaboration-'+name+'@studio.example';
    const signup=await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Local '+name+' fixture'}});
    assert.equal(signup.status,202);await signup.arrayBuffer();
    const mail=await relay.waitForCount(count),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');
    const verification=await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account'));
    assert.equal(verification.status,200);await verification.arrayBuffer();
    const signin=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}});
    assert.equal(signin.status,200);const cookie=accountCookies(signin),body=await signin.json();
    return {cookie,user:body.user,headers:{'X-Yumunio-Expected-Account':body.user.id}};
  }
  const owner=await register('owner',1),recipient=await register('recipient',2);
  const emptyPreferences=await f.request('/api/preferences',{cookie:owner.cookie,headers:owner.headers});
  assert.equal(emptyPreferences.status,200);assert.deepEqual(await emptyPreferences.json(),{revision:0,preferences:null});
  const preference=(themeId)=>({schemaVersion:1,themeId,customColors:{},fontId:'line-seed-jp',locale:'en'});
  const preferenceWrites=await Promise.all(['forest','paper'].map(themeId=>f.request('/api/preferences',{method:'PUT',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:0,preferences:preference(themeId)}})));
  assert.deepEqual(preferenceWrites.map(response=>response.status).sort(),[200,409]);
  const preferenceResults=await Promise.all(preferenceWrites.map(response=>response.json())),savedPreferences=preferenceResults.find(value=>value.revision===1);
  assert.ok(savedPreferences);assert.equal(savedPreferences.preferences.fontId,'line-seed-jp');
  assert.deepEqual(await(await f.request('/api/preferences',{cookie:recipient.cookie,headers:recipient.headers})).json(),{revision:0,preferences:null});
  const wrongPreferenceAccount=await f.request('/api/preferences',{method:'PUT',cookie:owner.cookie,headers:recipient.headers,body:{expectedRevision:1,preferences:preference('midnight')}});
  assert.equal(wrongPreferenceAccount.status,404);await wrongPreferenceAccount.arrayBuffer();
  const organization=await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'D1 collaboration',slug:'d1-collaboration'}});
  assert.equal(organization.status,200);const workspace=await organization.json();
  const content='/api/content/workspaces/'+workspace.id,collaboration='/api/collaboration/workspaces/'+workspace.id;
  const created=await f.request(content+'/pages',{method:'POST',cookie:owner.cookie,body:{expectedRevision:0,title:'Shared D1 fixture',blocks:[]}});
  assert.equal(created.status,201);const page=(await created.json()).page;
  const issued=await f.request(collaboration+'/invitations',{method:'POST',cookie:owner.cookie,headers:owner.headers,
    body:{expectedRevision:1,requestId:'d1-guest-invitation',purpose:'page-guest',email:recipient.user.email,role:'full',pageId:page.id,includeDescendants:false}});
  assert.equal(issued.status,201);const invitation=await issued.json();assert.equal(invitation.mailStatus,'queued');
  assert.doesNotMatch(JSON.stringify(invitation),/tokenHash|ciphertext|issuerMembershipId/);
  const message=await relay.waitForCount(3),link=new URL(message.text.split('\n').at(-1));
  const acceptance={invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')};
  const accepted=await f.request('/api/collaboration/accept',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:acceptance});
  assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{revision:3,workspaceId:workspace.id,pageId:page.id,role:'guest'});
  const replay=await f.request('/api/collaboration/accept',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:acceptance});
  assert.equal(replay.status,404);await replay.arrayBuffer();
  const readable=await f.request(content+'/pages/'+page.id,{cookie:recipient.cookie});assert.equal(readable.status,200);await readable.arrayBuffer();
  const rollback=await f.request('/api/__fixture/collaboration-rollback',{method:'POST',body:{workspaceId:workspace.id}});
  assert.equal(rollback.status,200);assert.deepEqual(await rollback.json(),{code:'COLLABORATION_CONFLICT',beforeRevision:3,afterRevision:3,titlePreserved:true,guards:0});
  const listed=await f.request(collaboration+'/members',{cookie:owner.cookie});assert.equal(listed.status,200);
  const members=(await listed.json()).members,ownerMember=members.find(row=>row.accountId===owner.user.id),guestMember=members.find(row=>row.accountId===recipient.user.id);
  assert.equal(guestMember.role,'guest');
  const lastOwner=await f.request(collaboration+'/members/'+ownerMember.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,role:'member'}});
  assert.equal(lastOwner.status,409);assert.equal((await lastOwner.json()).error.code,'LAST_WORKSPACE_OWNER');
  const grants=await (await f.request(content+'/pages/'+page.id+'/grants',{cookie:owner.cookie})).json(),ownerGrant=grants.grants.find(row=>row.accountId===owner.user.id);
  const revoked=await f.request(content+'/pages/'+page.id+'/grants/'+ownerGrant.id,{method:'DELETE',cookie:owner.cookie,body:{expectedRevision:3}});
  assert.equal(revoked.status,200);assert.equal((await revoked.json()).revision,4);
  const lastPage=await f.request(collaboration+'/members/'+guestMember.id,{method:'DELETE',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:4}});
  assert.equal(lastPage.status,409);const lastPageBody=await lastPage.text();assert.match(lastPageBody,/LAST_PAGE_MANAGER/);assert.equal(lastPageBody.includes(page.id),false);
  await f.restart();
  const after=await f.request(content+'/pages/'+page.id,{cookie:recipient.cookie});assert.equal(after.status,200);assert.equal((await after.json()).revision,4);
  const persistedPreferences=await f.request('/api/preferences',{cookie:owner.cookie,headers:owner.headers});
  assert.equal(persistedPreferences.status,200);assert.deepEqual(await persistedPreferences.json(),savedPreferences);
  const counts=await f.inspectD1("SELECT status,COUNT(*) AS count FROM yumunio_collaboration_invitations GROUP BY status");
  assert.deepEqual(counts,[{status:'accepted',count:1}]);
});


test('local workerd durably merges concurrent Yjs page text, rejects revoked guests and fences old epochs across D1 restart', { timeout: 240000 }, async t => {
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,isolatedAssets:true});
  async function register(name,count){
    const email='d1-room-'+name+'@studio.example';
    const signup=await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Room '+name+' fixture'}});assert.equal(signup.status,202);await signup.arrayBuffer();
    const message=await relay.waitForCount(count),token=new URL(message.text.split('\n').at(-1)).searchParams.get('verify');
    const verified=await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account'));assert.equal(verified.status,200);await verified.arrayBuffer();
    const signin=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}});assert.equal(signin.status,200);return{cookie:accountCookies(signin),user:(await signin.json()).user};
  }
  const owner=await register('owner',1),editor=await register('editor',2);
  const ownerHeaders={'X-Yumunio-Expected-Account':owner.user.id},editorHeaders={'X-Yumunio-Expected-Account':editor.user.id};
  const organization=await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'D1 Yjs room',slug:'d1-yjs-room'}});assert.equal(organization.status,200);const workspace=await organization.json();
  const content='/api/content/workspaces/'+workspace.id,collaboration='/api/collaboration/workspaces/'+workspace.id;
  const created=await f.request(content+'/pages',{method:'POST',cookie:owner.cookie,body:{expectedRevision:0,title:'Shared room',blocks:[{id:'shared',type:'paragraph',data:{text:'Hello'},children:[{id:'nested-heading',type:'heading',data:{text:'Heading'}},{id:'nested-check',type:'checklist',data:{text:'Checklist',checked:false}}]},{id:'source-parent',type:'paragraph',data:{text:'Original source',purpose:'import-source'},children:[{id:'source-child',type:'paragraph',data:{text:'Original child'}}]},{id:'unknown-parent',type:'future-kind',data:{text:'Future'},children:[{id:'unknown-child',type:'paragraph',data:{text:'Future child'}}]}]}});assert.equal(created.status,201);const page=await created.json(),path=content+'/pages/'+page.page.id;
  const issued=await f.request(collaboration+'/invitations',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:{expectedRevision:1,requestId:'room-editor-invitation',purpose:'page-guest',email:editor.user.email,role:'editor',pageId:page.page.id,includeDescendants:false}});assert.equal(issued.status,201);await issued.arrayBuffer();
  const message=await relay.waitForCount(3),link=new URL(message.text.split('\n').at(-1));
  const accepted=await f.request('/api/collaboration/accept',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}});assert.equal(accepted.status,200);await accepted.arrayBuffer();
  const openResponse=await f.request(path+'/room/open',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:{expectedRevision:3}});assert.equal(openResponse.status,201,await openResponse.clone().text());const opened=await openResponse.json();
  const editorOpen=await f.request(path+'/room/open',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:{expectedRevision:4}});assert.equal(editorOpen.status,200);const editorRoom=await editorOpen.json();assert.equal(editorRoom.editable,true);
  const baseline={title:page.page.title,blocks:page.document.blocks},a=loadRoomDocument(fromBase64(opened.update),baseline),b=loadRoomDocument(fromBase64(editorRoom.update),baseline),vector=Y.encodeStateVector(a);
  assert.equal(a.share.has('block:source-child'),false);assert.equal(a.share.has('block:unknown-child'),false);
  for(const id of ['source-child','unknown-child']){const bad=loadRoomDocument(fromBase64(opened.update),baseline);let body;try{bad.getText('block:'+id).insert(0,'Forbidden ');body={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(bad))};}finally{bad.destroy();}const refused=await f.request(path+'/room/updates',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body});assert.equal(refused.status,400);assert.equal((await refused.json()).error.code,'ROOM_CONTENT_UNSUPPORTED');}assert.deepEqual(await f.inspectD1('SELECT revision FROM yumunio_account_content'),[{revision:4}]);
  a.getText('block:shared').insert(5,' owner');b.getText('block:shared').insert(5,' guest');a.getText('block:nested-heading').insert(0,'Owner ');b.getText('block:nested-check').insert(0,'Guest ');
  const au={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(a,vector))},bu={epoch:editorRoom.epoch,ticket:editorRoom.ticket,update:toBase64(Y.encodeStateAsUpdate(b,vector))};a.destroy();b.destroy();
  const responses=await Promise.all([f.request(path+'/room/updates',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:au}),f.request(path+'/room/updates',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:bu})]);assert.deepEqual(responses.map(row=>row.status),[200,200]);for(const response of responses)assert.equal((await response.json()).acknowledged,true);
  const replay=await f.request(path+'/room/updates',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:au});assert.equal(replay.status,200);const ack=await replay.json();assert.equal(ack.revision,6);assert.equal(ack.sequence,3);
  const downgrade=await f.request(path+'/grants',{method:'POST',cookie:owner.cookie,body:{expectedRevision:6,accountId:editor.user.id,permission:'viewer'}});assert.equal(downgrade.status,200);await downgrade.arrayBuffer();
  const denied=await f.request(path+'/room/updates',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:bu});assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'ROOM_EPOCH_CHANGED');
  const persisted=await(await f.request(path,{cookie:owner.cookie})).json();assert.equal(persisted.document.version,3);assert.match(persisted.document.blocks[0].data.text,/owner/);assert.match(persisted.document.blocks[0].data.text,/guest/);
  assert.equal(persisted.document.blocks[0].children[0].data.text,'Owner Heading');assert.equal(persisted.document.blocks[0].children[1].data.text,'Guest Checklist');assert.equal(persisted.document.blocks[1].children[0].data.text,'Original child');assert.equal(persisted.document.blocks[2].children[0].data.text,'Future child');
  // Capability changes invalidate every old ticket. Reopen explicitly so a
  // current readonly ticket and the subsequent manual replacement are tested
  // independently of that earlier epoch fence.
  const afterAclResponse=await f.request(path+'/room/open',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:{expectedRevision:7}});assert.equal(afterAclResponse.status,201);const afterAcl=await afterAclResponse.json();assert.notEqual(afterAcl.epoch,opened.epoch);
  const readonlyResponse=await f.request(path+'/room/open',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:{expectedRevision:8}});assert.equal(readonlyResponse.status,200);const readonlyRoom=await readonlyResponse.json();assert.equal(readonlyRoom.editable,false);assert.equal(readonlyRoom.epoch,afterAcl.epoch);
  const readonlyWrite=await f.request(path+'/room/updates',{method:'POST',cookie:editor.cookie,headers:editorHeaders,body:{epoch:readonlyRoom.epoch,ticket:readonlyRoom.ticket,update:bu.update}});assert.equal(readonlyWrite.status,404);assert.equal((await readonlyWrite.json()).error.code,'CONTENT_NOT_FOUND');
  const currentDraft={title:persisted.page.title,blocks:persisted.document.blocks},pending=loadRoomDocument(fromBase64(afterAcl.update),currentDraft);let currentUpdate;
  try{const currentVector=Y.encodeStateVector(pending);pending.getText('title').insert(0,'Held ');currentUpdate={epoch:afterAcl.epoch,ticket:afterAcl.ticket,update:toBase64(Y.encodeStateAsUpdate(pending,currentVector))};}finally{pending.destroy();}
  const manual=await f.request(path,{method:'PATCH',cookie:owner.cookie,headers:ownerHeaders,body:{expectedRevision:8,expectedVersion:3,title:'Manual epoch replacement'}});assert.equal(manual.status,200);await manual.arrayBuffer();
  const stale=await f.request(path+'/room/updates',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:currentUpdate});assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'ROOM_EPOCH_CHANGED');
  const reopened=await f.request(path+'/room/open',{method:'POST',cookie:owner.cookie,headers:ownerHeaders,body:{expectedRevision:9}});assert.equal(reopened.status,201);const currentRoom=await reopened.json();assert.notEqual(currentRoom.epoch,opened.epoch);assert.notEqual(currentRoom.epoch,afterAcl.epoch);
  await f.restart();
  const restored=await(await f.request(path,{cookie:owner.cookie})).json();assert.equal(restored.page.title,'Manual epoch replacement');assert.equal(restored.document.version,4);assert.equal(restored.revision,10);assert.match(restored.document.blocks[0].data.text,/owner/);assert.match(restored.document.blocks[0].data.text,/guest/);
  assert.equal(restored.document.blocks[1].children[0].data.text,'Original child');assert.equal(restored.document.blocks[0].children[0].data.text,'Owner Heading');
  const state=await f.request(path+'/room',{cookie:owner.cookie,headers:{...ownerHeaders,'X-Yumunio-Room-Ticket':currentRoom.ticket}});assert.equal(state.status,200);assert.equal((await state.json()).epoch,currentRoom.epoch);
  const counts=await f.inspectD1("SELECT revision,json_array_length(json_extract(payload_json,'$.rooms')) AS rooms,json_extract(payload_json,'$.rooms[0].sequence') AS sequence FROM yumunio_account_content");assert.deepEqual(counts,[{revision:10,rooms:1,sequence:1}]);
});

test('local workerd persists typed native collections, saved views and row ACL with atomic D1 CAS across restart', {timeout:240000}, async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay});
  async function register(name,count){const email='d1-typed-'+name+'@studio.example',signup=await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Typed '+name+' fixture'}});assert.equal(signup.status,202);await signup.arrayBuffer();const message=await relay.waitForCount(count),token=new URL(message.text.split('\n').at(-1)).searchParams.get('verify');const verified=await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account'));assert.equal(verified.status,200);await verified.arrayBuffer();const signin=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}});assert.equal(signin.status,200);return{cookie:accountCookies(signin),user:(await signin.json()).user};}
  const owner=await register('owner',1),reader=await register('reader',2);owner.headers={'X-Yumunio-Expected-Account':owner.user.id};reader.headers={'X-Yumunio-Expected-Account':reader.user.id};
  const organization=await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'Typed D1 fixture',slug:'typed-d1-fixture'}});assert.equal(organization.status,200);const workspace=await organization.json(),base='/api/content/workspaces/'+workspace.id,collaboration='/api/collaboration/workspaces/'+workspace.id;
  const props=[{id:'memo',name:'Memo',type:'text'},{id:'count',name:'Count',type:'number'},{id:'done',name:'Done',type:'checkbox'},{id:'date',name:'Date',type:'date'},{id:'status',name:'Status',type:'select',options:['New','Done']},{id:'tags',name:'Tags',type:'multi_select',options:['A','B']},{id:'person',name:'Person',type:'person'},{id:'related',name:'Related',type:'relation'}];
  const created=await f.request(base+'/collections',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:0,title:'Typed collection',parentId:null,properties:props}});assert.equal(created.status,201,await created.clone().text());const collection=await created.json(),path=base+'/collections/'+collection.collectionId;
  const firstResponse=await f.request(path+'/records',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:1,title:'Visible row',values:{memo:'007 日本語 😀',count:2,done:true,date:'2026-10-15',status:'New',tags:['B','A'],person:owner.user.id}}});assert.equal(firstResponse.status,201,await firstResponse.clone().text());const first=(await firstResponse.json()).record;assert.equal(first.values.related,null);assert.equal(first.sourceKind,'manual');assert.deepEqual(first.sourceValues,{});
  const secondResponse=await f.request(path+'/records',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:2,title:'Hidden row',values:{memo:'Private row',count:5,person:owner.user.id,related:[first.pageId]}}});assert.equal(secondResponse.status,201);const second=(await secondResponse.json()).record;
  const schema=await f.request(path,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,properties:[...props,{id:'extra',name:'Extra',type:'text'}]}});assert.equal(schema.status,200);await schema.arrayBuffer();
  const view={name:'By status',type:'board',filters:[],sorts:[{propertyId:'count',direction:'desc'}],groupBy:'status',datePropertyId:null,endDatePropertyId:null};const savedView=await f.request(path+'/views',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:4,view}});assert.equal(savedView.status,201);const viewId=(await savedView.json()).viewId;
  const changes=await Promise.all(['CAS A','CAS B'].map(memo=>f.request(path+'/records/'+first.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:5,values:{memo}}})));assert.deepEqual(changes.map(response=>response.status).sort(),[200,409]);let winner;for(const response of changes){const result=await response.json();if(response.status===200)winner=result.record.values.memo;}assert.ok(winner);
  const invited=await f.request(collaboration+'/invitations',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:6,requestId:'typed-reader',purpose:'page-guest',email:reader.user.email,role:'viewer',pageId:collection.pageId,includeDescendants:false}});assert.equal(invited.status,201);await invited.arrayBuffer();const mail=await relay.waitForCount(3),link=new URL(mail.text.split('\n').at(-1));const accepted=await f.request('/api/collaboration/accept',{method:'POST',cookie:reader.cookie,headers:reader.headers,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}});assert.equal(accepted.status,200);await accepted.arrayBuffer();
  const granted=await f.request(base+'/pages/'+first.pageId+'/grants',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:8,accountId:reader.user.id,permission:'viewer'}});assert.equal(granted.status,200);await granted.arrayBuffer();const related=await f.request(path+'/records/'+first.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:9,values:{related:[second.pageId]}}});assert.equal(related.status,200);await related.arrayBuffer();
  const visible=await f.request(path,{cookie:reader.cookie,headers:reader.headers});assert.equal(visible.status,200);const limited=await visible.json();assert.equal(limited.collection.records.length,1);assert.deepEqual(limited.collection.records[0].values.related,[]);assert.equal(JSON.stringify(limited).includes(second.pageId),false);
  const denied=await f.request(path+'/records/'+first.id,{method:'PATCH',cookie:reader.cookie,headers:reader.headers,body:{expectedRevision:10,values:{memo:'Forbidden'}}});assert.equal(denied.status,404);await denied.arrayBuffer();
  await f.restart();const persisted=await(await f.request(path,{cookie:owner.cookie,headers:owner.headers})).json();assert.equal(persisted.revision,10);assert.equal(persisted.collection.properties.length,9);assert.deepEqual(persisted.collection.sourceProperties,[]);const restoredFirst=persisted.collection.records.find(row=>row.id===first.id);assert.equal(restoredFirst.values.memo,winner);assert.equal(restoredFirst.values.extra,null);assert.deepEqual(restoredFirst.values.related,[second.pageId]);
  const projected=await(await f.request(path+'/views/'+viewId,{cookie:reader.cookie,headers:reader.headers})).json();assert.equal(projected.view.type,'board');assert.equal(projected.collection.records.length,1);assert.deepEqual(projected.collection.records[0].values.related,[]);
  const trashed=await f.request(path+'/records/'+first.id,{method:'DELETE',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:10}});assert.equal(trashed.status,200);await trashed.arrayBuffer();const empty=await(await f.request(path,{cookie:reader.cookie,headers:reader.headers})).json();assert.deepEqual(empty.collection.records,[]);
  const restored=await f.request(base+'/pages/'+first.pageId+'/restore',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:11,parentId:collection.pageId}});assert.equal(restored.status,200);await restored.arrayBuffer();const final=await(await f.request(path,{cookie:reader.cookie,headers:reader.headers})).json();assert.equal(final.revision,12);assert.equal(final.collection.records.length,1);assert.deepEqual(final.collection.records[0].values.related,[]);
});
test('local workerd persists page comments and private mention inbox with live D1 permissions and safe people labels', {timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay});
  async function register(name,count){const email='d1-comments-'+name+'@studio.example';const signup=await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Comments '+name+' fixture'}});assert.equal(signup.status,202);await signup.arrayBuffer();const mail=await relay.waitForCount(count),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');const verified=await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account'));assert.equal(verified.status,200);await verified.arrayBuffer();const login=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}});assert.equal(login.status,200);return{cookie:accountCookies(login),user:(await login.json()).user};}
  const owner=await register('owner',1),recipient=await register('recipient',2);owner.headers={'X-Yumunio-Expected-Account':owner.user.id};recipient.headers={'X-Yumunio-Expected-Account':recipient.user.id};
  const organization=await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'D1 comments fixture',slug:'d1-comments-fixture'}});assert.equal(organization.status,200);const workspace=await organization.json(),base='/api/content/workspaces/'+workspace.id,collaboration='/api/collaboration/workspaces/'+workspace.id;
  const created=await f.request(base+'/pages',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:0,title:'Comments fixture',blocks:[{id:'paragraph',type:'paragraph',data:{text:'Synthetic body'}},{id:'source',type:'code',data:{text:'Original source',purpose:'import-source'}}]}});assert.equal(created.status,201);const page=(await created.json()).page,path=base+'/pages/'+page.id;
  const invited=await f.request(collaboration+'/invitations',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:1,requestId:'comments-recipient',purpose:'page-guest',email:recipient.user.email,role:'commenter',pageId:page.id,includeDescendants:false}});assert.equal(invited.status,201);await invited.arrayBuffer();const mail=await relay.waitForCount(3),link=new URL(mail.text.split('\n').at(-1));const accepted=await f.request('/api/collaboration/accept',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}});assert.equal(accepted.status,200);await accepted.arrayBuffer();
  const people=await f.request(path+'/people',{cookie:recipient.cookie,headers:recipient.headers});assert.equal(people.status,200);const labels=await people.json();assert.deepEqual(labels.people.map(person=>person.accountId).sort(),[owner.user.id,recipient.user.id].sort());assert.ok(labels.people.every(person=>Object.keys(person).sort().join(',')==='accountId,name'));assert.doesNotMatch(JSON.stringify(labels),/@studio|email|membership/);
  const badRange=await f.request(path+'/comments',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:{expectedRevision:3,blockId:'paragraph',text:'Hi @Owner',mentions:[{accountId:owner.user.id,start:0,end:9}]}});assert.equal(badRange.status,400);await badRange.arrayBuffer();
  const posted=await f.request(path+'/comments',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:{expectedRevision:3,blockId:'paragraph',text:'Hi @Owner',mentions:[{accountId:owner.user.id,start:3,end:9}]}});assert.equal(posted.status,200,await posted.clone().text());const thread=(await posted.json()).thread,message=thread.messages[0];
  const inbox=await(await f.request(base+'/notifications',{cookie:owner.cookie,headers:owner.headers})).json();assert.equal(inbox.notifications.length,1);assert.equal((await(await f.request(base+'/notifications',{cookie:recipient.cookie,headers:recipient.headers})).json()).notifications.length,0);
  assert.equal(inbox.notifications[0].reason,'mention');
  const mark=await f.request(base+'/notifications',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:4,notificationIds:[inbox.notifications[0].id]}});assert.equal(mark.status,200);await mark.arrayBuffer();
  const edited=await f.request(path+'/comments/'+thread.id+'/messages/'+message.id,{method:'PATCH',cookie:recipient.cookie,headers:recipient.headers,body:{expectedRevision:5,text:'Hello @Owner',mentions:[{accountId:owner.user.id,start:6,end:12}]}});assert.equal(edited.status,200);await edited.arrayBuffer();const unchanged=(await(await f.request(base+'/notifications',{cookie:owner.cookie,headers:owner.headers})).json()).notifications;assert.equal(unchanged[0].id,inbox.notifications[0].id);assert.notEqual(unchanged[0].readAt,null);
  const impersonation=await f.request(path+'/comments/'+thread.id+'/messages/'+message.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:6,text:'Cannot impersonate',mentions:[]}});assert.equal(impersonation.status,404);await impersonation.arrayBuffer();
  const reply=await f.request(path+'/comments/'+thread.id,{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:6,text:'Manager reply',mentions:[]}});assert.equal(reply.status,200);await reply.arrayBuffer();const deleted=await f.request(path+'/comments/'+thread.id+'/messages/'+message.id,{method:'DELETE',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:7}});assert.equal(deleted.status,200);const moderated=(await deleted.json()).thread;assert.equal(moderated.messages[0].text,'');assert.equal(moderated.messages[1].text,'Manager reply');assert.deepEqual((await(await f.request(base+'/notifications',{cookie:owner.cookie,headers:owner.headers})).json()).notifications,[]);
  const replyInbox=(await(await f.request(base+'/notifications',{cookie:recipient.cookie,headers:recipient.headers})).json()).notifications;assert.equal(replyInbox.length,1);assert.equal(replyInbox[0].reason,'reply');assert.equal(replyInbox[0].text,'Manager reply');
  const resolved=await f.request(path+'/comments/'+thread.id+'/resolve',{method:'PATCH',cookie:recipient.cookie,headers:recipient.headers,body:{expectedRevision:8,resolved:true}});assert.equal(resolved.status,200);await resolved.arrayBuffer();
  await f.restart();const persisted=await f.request(path+'/comments',{cookie:owner.cookie,headers:owner.headers});assert.equal(persisted.status,200);const after=await persisted.json();assert.equal(after.revision,9);assert.notEqual(after.threads[0].resolvedAt,null);assert.equal(after.threads[0].messages[0].authorId,recipient.user.id);assert.equal(after.threads[0].messages[0].text,'');assert.equal(after.threads[0].messages[1].text,'Manager reply');assert.doesNotMatch(JSON.stringify(after),/authorMembershipId|recipientMembershipId|@studio/);
  const restartedInbox=(await(await f.request(base+'/notifications',{cookie:recipient.cookie,headers:recipient.headers})).json()).notifications;assert.equal(restartedInbox[0].id,replyInbox[0].id);assert.equal(restartedInbox[0].reason,'reply');
  const downgrade=await f.request(path+'/grants',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:9,accountId:recipient.user.id,permission:'viewer'}});assert.equal(downgrade.status,200);await downgrade.arrayBuffer();const denied=await f.request(path+'/comments',{method:'POST',cookie:recipient.cookie,headers:recipient.headers,body:{expectedRevision:10,blockId:null,text:'Denied',mentions:[]}});assert.equal(denied.status,404);await denied.arrayBuffer();
  const grants=(await(await f.request(path+'/grants',{cookie:owner.cookie,headers:owner.headers})).json()).grants,recipientGrant=grants.find(grant=>grant.accountId===recipient.user.id);const revoke=await f.request(path+'/grants/'+recipientGrant.id,{method:'DELETE',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:10}});assert.equal(revoke.status,200);await revoke.arrayBuffer();const hidden=await f.request(path+'/comments',{cookie:recipient.cookie,headers:recipient.headers});assert.equal(hidden.status,404);await hidden.arrayBuffer();
  assert.deepEqual((await(await f.request(base+'/notifications',{cookie:recipient.cookie,headers:recipient.headers})).json()).notifications,[]);
});

test('local workerd persists create-only assigned form responses exactly once across D1 restart without granting response read', {timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function register(name,count){const email='d1-forms-'+name+'@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Forms '+name+' fixture'}}),202);const mail=await relay.waitForCount(count),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const login=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(login),user=(await ok(login)).user;return{cookie,user,headers:{'X-Yumunio-Expected-Account':user.id}};}
  const owner=await register('owner',1),respondent=await register('respondent',2),workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'D1 forms fixture',slug:'d1-forms-fixture'}})),base='/api/content/workspaces/'+workspace.id,collaboration='/api/collaboration/workspaces/'+workspace.id;
  const collection=await ok(await f.request(base+'/collections',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:0,title:'Private form responses',parentId:null,properties:[{id:'rating',name:'Rating',type:'number',required:true}]}}),201),path=base+'/collections/'+collection.collectionId+'/forms';
  await ok(await f.request(collaboration+'/invitations',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:1,requestId:'forms-member',purpose:'workspace-member',email:respondent.user.email,role:'member',pageId:null}}),201);const mail=await relay.waitForCount(3),link=new URL(mail.text.split('\n').at(-1));await ok(await f.request('/api/collaboration/accept',{method:'POST',cookie:respondent.cookie,headers:respondent.headers,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}}));
  const created=await ok(await f.request(path,{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,definition:{title:'Feedback',description:'Assigned account',fields:[{id:'rating',propertyId:'rating',label:'Your rating',description:'',required:true,condition:null}]}}}),201),manage=path+'/'+created.formId,respond=base+'/forms/'+created.formId;
  await ok(await f.request(manage+'/acceptance',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:4,accepting:true,confirmManagerAccess:true,respondentAccountIds:[respondent.user.id]}}));const questions=await ok(await f.request(respond,{cookie:respondent.cookie,headers:respondent.headers}));assert.equal(questions.fields[0].type,'number');assert.equal(Object.hasOwn(questions,'revision'),false);assert.equal(Object.hasOwn(questions.fields[0],'propertyId'),false);
  const body={requestId:'d1-form-receipt',version:1,answers:{rating:0}},responses=await Promise.all([f.request(respond+'/responses',{method:'POST',cookie:respondent.cookie,headers:respondent.headers,body}),f.request(respond+'/responses',{method:'POST',cookie:respondent.cookie,headers:respondent.headers,body})]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);for(const response of responses)assert.deepEqual(await response.json(),{requestId:'d1-form-receipt',accepted:true});
  const saved=await ok(await f.request(base+'/collections/'+collection.collectionId,{cookie:owner.cookie,headers:owner.headers}));assert.equal(saved.revision,6);assert.equal(saved.collection.records.length,1);assert.equal(saved.collection.records[0].values.rating,0);const pageId=saved.collection.records[0].pageId;
  for(const path of [base+'/collections/'+collection.collectionId,base+'/pages/'+pageId]){const denied=await f.request(path,{cookie:respondent.cookie,headers:respondent.headers});assert.equal(denied.status,404);await denied.arrayBuffer();}assert.deepEqual((await ok(await f.request(base+'/pages',{cookie:respondent.cookie,headers:respondent.headers}))).pages,[]);
  await f.restart();assert.deepEqual(await ok(await f.request(respond+'/responses',{method:'POST',cookie:respondent.cookie,headers:respondent.headers,body})),{requestId:'d1-form-receipt',accepted:true});const source=await ok(await f.request(base+'/pages/'+pageId,{cookie:owner.cookie,headers:owner.headers}));assert.deepEqual(JSON.parse(source.document.blocks[0].data.text).questions,[{label:'Your rating',value:0}]);
  await ok(await f.request(manage+'/acceptance',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:6,accepting:false}}));const closed=await f.request(respond+'/responses',{method:'POST',cookie:respondent.cookie,headers:respondent.headers,body});assert.equal(closed.status,404);await closed.arrayBuffer();const counts=await f.inspectD1("SELECT revision,json_array_length(json_extract(payload_json,'$.collections[0].collection.records')) AS responses,json_array_length(json_extract(payload_json,'$.formReceipts')) AS receipts FROM yumunio_account_content");assert.deepEqual(counts,[{revision:7,responses:1,receipts:1}]);
});


test('local workerd binds normal page uploads to private R2 attachments and deletes fenced bytes across D1 restart',{timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,blobs:'r2'});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='d1-page-upload@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Page upload fixture'}}),202);const mail=await relay.waitForCount(1),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const signin=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(signin),user=(await ok(signin)).user,headers={'X-Yumunio-Expected-Account':user.id};
  const workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie,body:{name:'Page upload fixture',slug:'page-upload-fixture'}})),base='/api/content/workspaces/'+workspace.id;const page=await ok(await f.request(base+'/pages',{method:'POST',cookie,headers,body:{expectedRevision:0,title:'Normal page',blocks:[{id:'plain',type:'paragraph',data:{text:'Keep this body'}}]}}),201),path=base+'/pages/'+page.page.id,upload=path+'/uploads/ordinary-upload/assets';
  const bytes=new TextEncoder().encode('Normal page upload 日本語 😀'),checksum=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');const reservation=await ok(await f.request(upload,{method:'POST',cookie,headers,body:{expectedRevision:1,sourceId:'file',name:'架空.txt',mediaType:'text/plain',size:bytes.length,checksum}}),201);
  const listed=await ok(await f.request(path+'/uploads',{cookie,headers}));assert.equal(listed.uploads.length,1);assert.equal(listed.uploads[0].uploadId,'ordinary-upload');assert.doesNotMatch(JSON.stringify(listed),/objectKey|profileId|membershipId/);assert.deepEqual((await ok(await f.request(base+'/imports/ordinary-upload/assets',{cookie,headers}))).assets,[]);
  await ok(await f.request(upload+'/'+reservation.assetId,{method:'PUT',cookie,binary:true,headers:{...headers,'X-Yumunio-Expected-Revision':'2'},body:bytes}));const committed=await ok(await f.request(upload+'/'+reservation.assetId+'/commit',{method:'POST',cookie,headers,body:{expectedRevision:3,expectedVersion:1}}),201);assert.equal(committed.revision,4);assert.equal(committed.version,1);assert.equal(committed.replayed,false);
  await f.restart();const current=await ok(await f.request(path,{cookie,headers}));assert.equal(current.document.version,1);assert.equal(current.document.blocks[0].data.text,'Keep this body');assert.equal(current.attachments[0].id,reservation.assetId);const downloaded=await f.request(path+'/attachments/'+reservation.assetId,{cookie});assert.equal(downloaded.status,200);assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()),bytes);
  const replay=await ok(await f.request(upload+'/'+reservation.assetId+'/commit',{method:'POST',cookie,headers,body:{expectedRevision:0,expectedVersion:0}}));assert.equal(replay.replayed,true);assert.equal(replay.revision,4);
  const removed=await ok(await f.request(path+'/attachments/'+reservation.assetId,{method:'DELETE',cookie,headers,body:{expectedRevision:4,expectedVersion:1}}));assert.equal(removed.revision,6);assert.equal(removed.removed,true);const gone=await f.request(path+'/attachments/'+reservation.assetId,{cookie});assert.equal(gone.status,404);await gone.arrayBuffer();assert.deepEqual(await(await f.request('/api/__fixture/blob-status')).json(),{objects:0});
});

test('local workerd serves only explicit public snapshots without cookies and fences source changes and stopped URLs across D1 restart',{timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  const email='d1-publication@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Publication fixture'}}),202);const mail=await relay.waitForCount(1),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const signed=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(signed),user=(await ok(signed)).user,headers={'X-Yumunio-Expected-Account':user.id};
  const workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie,body:{name:'Publication fixture',slug:'publication-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const created=await ok(await f.request(base+'/pages',{method:'POST',cookie,headers,body:{expectedRevision:0,title:'Published snapshot',blocks:[{id:'paragraph',type:'paragraph',data:{text:'Literal <b>public text</b>'}},{id:'source',type:'code',data:{text:'Private original source',purpose:'import-source'}}]}}),201),pagePath=base+'/pages/'+created.page.id,path=pagePath+'/publication';
  await ok(await f.request(base+'/pages',{method:'POST',cookie,headers,body:{expectedRevision:1,parentId:created.page.id,title:'Private child',blocks:[{id:'hidden',type:'paragraph',data:{text:'Private child contents'}}]}}),201);
  const publish=async expectedRevision=>{const review=await ok(await f.request(path+'/review',{method:'POST',cookie,headers,body:{expectedRevision}}));assert.equal(review.sourceVersion,expectedRevision===2?1:2);return ok(await f.request(path,{method:'POST',cookie,headers,body:{expectedRevision,reviewDigest:review.reviewDigest,confirmPublicExposure:true}}));};
  const first=await publish(2),publicPath='/api/public/pages/'+new URL(first.publicPath,f.origin).searchParams.get('publication'),anonymous=await f.request(publicPath);assert.equal(anonymous.status,200);assert.match(anonymous.headers.get('cache-control'),/no-store/);assert.match(anonymous.headers.get('x-robots-tag'),/noindex/);assert.equal(anonymous.headers.has('set-cookie'),false);const body=await anonymous.json();assert.deepEqual(Object.keys(body).sort(),['blocks','mode','publishedAt','schemaVersion','title']);assert.deepEqual(body.blocks,[{type:'paragraph',text:'Literal <b>public text</b>'}]);assert.doesNotMatch(JSON.stringify(body),/Private|source|workspace|membership|@studio/);
  const privateResponse=await f.request(pagePath);assert.equal(privateResponse.status,401);await privateResponse.arrayBuffer();await ok(await f.request(pagePath,{method:'PATCH',cookie,headers,body:{expectedRevision:3,expectedVersion:1,title:'Updated source'}}));const stale=await f.request(publicPath);assert.equal(stale.status,404);await stale.arrayBuffer();const status=await ok(await f.request(path,{cookie,headers}));assert.equal(status.needsRepublish,true);assert.equal(status.publicPath,null);
  const second=await publish(4),nextPath='/api/public/pages/'+new URL(second.publicPath,f.origin).searchParams.get('publication');assert.notEqual(publicPath,nextPath);await f.restart();const current=await ok(await f.request(nextPath));assert.equal(current.title,'Updated source');const old=await f.request(publicPath);assert.equal(old.status,404);await old.arrayBuffer();
  await ok(await f.request(path,{method:'DELETE',cookie,headers,body:{expectedRevision:5}}));const stopped=await f.request(nextPath);assert.equal(stopped.status,404);await stopped.arrayBuffer();const counts=await f.inspectD1("SELECT revision,json_array_length(json_extract(payload_json,'$.pages')) AS pages,json_array_length(json_extract(payload_json,'$.grants')) AS grants,json_array_length(json_extract(payload_json,'$.publications')) AS publications,json_extract(payload_json,'$.publications[0].active') AS active FROM yumunio_account_content");assert.deepEqual(counts,[{revision:6,pages:2,grants:2,publications:1,active:0}]);
});

test('local workerd persists bounded formula projections and nonmutating previews with D1 CAS and row ACL across restart',{timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function register(name,count){const email='d1-formula-'+name+'@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Formula '+name+' fixture'}}),202);const message=await relay.waitForCount(count),token=new URL(message.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const response=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(response),user=(await ok(response)).user;return{cookie,user,headers:{'X-Yumunio-Expected-Account':user.id}};}
  const owner=await register('owner',1),reader=await register('reader',2),workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'Formula D1 fixture',slug:'formula-d1-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const prop=(id,type='number')=>({id,name:id,type}),formula=(id,expression,resultType='number')=>({id,name:id,type:'formula',formula:{version:1,expression,resultType}});
  const properties=[prop('price'),prop('quantity'),prop('due','date'),formula('total','field("price") * field("quantity")'),formula('caption','concat("Total ", toText(field("total")))','text'),formula('later','dateAdd(field("due"), 1)','date'),formula('division','field("price") / 0')];
  const collection=await ok(await f.request(base+'/collections',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:0,title:'Computed D1 collection',parentId:null,properties}}),201),path=base+'/collections/'+collection.collectionId;
  const first=(await ok(await f.request(path+'/records',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:1,title:'Visible row',values:{price:12.5,quantity:2,due:'2024-02-28'}}}),201)).record;
  assert.equal(first.values.total,25);assert.equal(first.values.caption,'Total 25');assert.equal(first.values.later,'2024-02-29');assert.equal(first.values.division,null);assert.deepEqual(first.formulaErrors,{division:{code:'FORMULA_DIVISION_BY_ZERO'}});
  const second=(await ok(await f.request(path+'/records',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:2,title:'Private formula row',values:{price:999,quantity:10}}}),201)).record;
  const previewProperty=formula('preview','field("total") + 1');
  const validation=await ok(await f.request(path+'/formulas/preview',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,property:previewProperty}}));assert.deepEqual(validation,{revision:3,propertyId:'preview',valid:true});
  const preview=await ok(await f.request(path+'/formulas/preview',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,property:previewProperty,recordId:first.id}}));assert.deepEqual(preview.result,{recordId:first.id,value:26});
  const cycle=await f.request(path+'/formulas/preview',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,property:formula('preview','field("preview")')}});assert.equal(cycle.status,400);assert.equal((await cycle.json()).error.code,'FORMULA_CYCLE');
  const readonly=await f.request(path+'/records/'+first.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,values:{total:999}}});assert.equal(readonly.status,400);assert.equal((await readonly.json()).error.code,'COMPUTED_PROPERTY_READ_ONLY');
  const changes=await Promise.all([10,11].map(price=>f.request(path+'/records/'+first.id,{method:'PATCH',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:3,values:{price}}})));assert.deepEqual(changes.map(response=>response.status).sort(),[200,409]);let winner;for(const response of changes){const body=await response.json();if(response.status===200){winner=body.record.values.price;assert.equal(body.record.values.total,winner*2);}}assert.ok(winner);
  const view={name:'Formula date',type:'calendar',filters:[{propertyId:'total',operator:'gte',value:20}],sorts:[{propertyId:'total',direction:'desc'}],groupBy:null,datePropertyId:'later',endDatePropertyId:null};
  const saved=await ok(await f.request(path+'/views',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:4,view}}),201);
  await ok(await f.request('/api/collaboration/workspaces/'+workspace.id+'/invitations',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:5,requestId:'formula-reader',purpose:'page-guest',email:reader.user.email,role:'viewer',pageId:collection.pageId,includeDescendants:false}}),201);
  const message=await relay.waitForCount(3),link=new URL(message.text.split('\n').at(-1));await ok(await f.request('/api/collaboration/accept',{method:'POST',cookie:reader.cookie,headers:reader.headers,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}}));
  await ok(await f.request(base+'/pages/'+collection.pageId+'/grants',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:7,accountId:reader.user.id,permission:'full'}}));
  await ok(await f.request(base+'/pages/'+first.pageId+'/grants',{method:'POST',cookie:owner.cookie,headers:owner.headers,body:{expectedRevision:8,accountId:reader.user.id,permission:'viewer'}}));
  const visible=await ok(await f.request(path,{cookie:reader.cookie,headers:reader.headers}));assert.equal(visible.revision,9);assert.equal(visible.collection.records.length,1);assert.deepEqual(visible.collection.records.map(({id,pageId,title})=>({id,pageId,title})),[{id:first.id,pageId:first.pageId,title:'Visible row'}]);assert.equal(visible.collection.records[0].values.total,winner*2);assertNoPrivateJsonLiterals(visible,[second.id,second.pageId,'Private formula row',999,'999',9990,'9990','Total 9990']);
  const hidden=await f.request(path+'/formulas/preview',{method:'POST',cookie:reader.cookie,headers:reader.headers,body:{expectedRevision:9,property:previewProperty,recordId:second.id}});assert.equal(hidden.status,404);assert.equal((await hidden.json()).error.code,'CONTENT_NOT_FOUND');
  const permitted=await ok(await f.request(path+'/formulas/preview',{method:'POST',cookie:reader.cookie,headers:reader.headers,body:{expectedRevision:9,property:previewProperty,recordId:first.id}}));assert.equal(permitted.result.value,winner*2+1);
  await f.restart();const persisted=await ok(await f.request(path,{cookie:owner.cookie,headers:owner.headers}));assert.equal(persisted.revision,9);assert.equal(persisted.collection.properties.length,7);const row=persisted.collection.records.find(record=>record.id===first.id);assert.equal(row.values.caption,'Total '+winner*2);assert.equal(row.values.later,'2024-02-29');assert.equal(persisted.collection.properties.some(property=>property.id==='preview'),false);
  const projected=await ok(await f.request(path+'/views/'+saved.viewId,{cookie:reader.cookie,headers:reader.headers}));assert.equal(projected.view.type,'calendar');assert.equal(projected.collection.records.length,1);assert.equal(projected.collection.records[0].values.total,winner*2);
  const counts=await f.inspectD1("SELECT revision,json_extract(payload_json,'$.collections[0].collection.records[0].values.total') AS total,json_extract(payload_json,'$.collections[0].collection.records[0].values.caption') AS caption,json_array_length(json_extract(payload_json,'$.collections[0].collection.properties')) AS properties FROM yumunio_account_content");assert.deepEqual(counts,[{revision:9,total:null,caption:null,properties:7}]);
});
test('local workerd persists one-hop rollups with complete target ACL checks and readonly D1 projections across restart',{timeout:240000},async t=>{
  const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,isolatedAssets:true});
  async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
  async function register(name,count){const email='d1-rollup-'+name+'@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Rollup '+name+' fixture'}}),202);const message=await relay.waitForCount(count),token=new URL(message.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const response=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(response),user=(await ok(response)).user;return{cookie,user,headers:{'X-Yumunio-Expected-Account':user.id}};}
  const owner=await register('owner',1),reader=await register('reader',2),workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'Rollup D1 fixture',slug:'rollup-d1-fixture'}})),base='/api/content/workspaces/'+workspace.id;
  const call=(path,{method='GET',body,account=owner}={})=>f.request(path,{method,body,cookie:account.cookie,headers:account.headers});
  const target=await ok(await call(base+'/collections',{method:'POST',body:{expectedRevision:0,title:'Private target',parentId:null,properties:[{id:'amount',name:'Amount',type:'number'},{id:'due',name:'Due',type:'date'}]}}),201),targetPath=base+'/collections/'+target.collectionId;
  const one=(await ok(await call(targetPath+'/records',{method:'POST',body:{expectedRevision:1,title:'First target',values:{amount:2,due:'2026-10-15'}}}),201)).record,two=(await ok(await call(targetPath+'/records',{method:'POST',body:{expectedRevision:2,title:'Hidden second target',values:{amount:3,due:'2026-10-16'}}}),201)).record;
  const rollup=(id,targetPropertyId,operation='sum',resultType='number')=>({id,name:id,type:'rollup',rollup:{version:1,relationPropertyId:'related',targetCollectionId:target.collectionId,targetPropertyId,operation,resultType}}),properties=[{id:'related',name:'Related',type:'relation'},rollup('sum','amount'),rollup('count',null,'count'),rollup('latest','due','max','date')];
  const source=await ok(await call(base+'/collections',{method:'POST',body:{expectedRevision:3,title:'Visible rollup source',parentId:null,properties}}),201),path=base+'/collections/'+source.collectionId,row=(await ok(await call(path+'/records',{method:'POST',body:{expectedRevision:4,title:'Linked source',values:{related:[one.pageId,two.pageId]}}}),201)).record;assert.equal(row.values.sum,5);assert.equal(row.values.count,2);assert.equal(row.values.latest,'2026-10-16');
  const preview=await ok(await call(path+'/rollups/preview',{method:'POST',body:{expectedRevision:5,property:rollup('preview','amount','min'),recordId:row.id}}));assert.deepEqual(preview.result,{recordId:row.id,value:2});const readonly=await call(path+'/records/'+row.id,{method:'PATCH',body:{expectedRevision:5,values:{sum:null}}});assert.equal(readonly.status,400);assert.equal((await readonly.json()).error.code,'COMPUTED_PROPERTY_READ_ONLY');
  const updates=await Promise.all([7,8].map(amount=>call(targetPath+'/records/'+one.id,{method:'PATCH',body:{expectedRevision:5,values:{amount}}})));assert.deepEqual(updates.map(response=>response.status).sort(),[200,409]);let winner;for(const response of updates){const result=await response.json();if(response.status===200)winner=result.record.values.amount;}
  const saved=await ok(await call(path+'/views',{method:'POST',body:{expectedRevision:6,view:{name:'Rollup calendar',type:'calendar',filters:[{propertyId:'sum',operator:'gte',value:5}],sorts:[{propertyId:'count',direction:'desc'}],groupBy:null,datePropertyId:'latest',endDatePropertyId:null}}}),201);
  await ok(await call('/api/collaboration/workspaces/'+workspace.id+'/invitations',{method:'POST',body:{expectedRevision:7,requestId:'rollup-reader',purpose:'page-guest',email:reader.user.email,role:'viewer',pageId:source.pageId,includeDescendants:false}}),201);const message=await relay.waitForCount(3),link=new URL(message.text.split('\n').at(-1));await ok(await call('/api/collaboration/accept',{method:'POST',account:reader,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}}));
  const grant=async(pageId,expectedRevision)=>ok(await call(base+'/pages/'+pageId+'/grants',{method:'POST',body:{expectedRevision,accountId:reader.user.id,permission:'viewer'}}));await grant(row.pageId,9);
  let limited=await ok(await call(path,{account:reader}));assert.equal(limited.collection.records[0].values.sum,null);assert.equal(limited.collection.records[0].values.count,null);assert.equal(limited.collection.properties[1].rollup.redacted,true);assert.equal(limited.collection.properties[1].rollup.targetCollectionId,null);assert.equal(JSON.stringify(limited).includes(target.collectionId),false);const exported=await ok(await call(base+'/export?format=json',{account:reader}));assert.equal(JSON.stringify(exported).includes(target.collectionId),false);
  await grant(target.pageId,10);await grant(one.pageId,11);limited=await ok(await call(path,{account:reader}));assert.deepEqual(limited.collection.records[0].values.related,[one.pageId]);for(const id of ['sum','count','latest']){assert.equal(limited.collection.records[0].values[id],null);assert.equal(limited.collection.records[0].rollupErrors[id].code,'ROLLUP_REDACTED_INPUT');}assert.equal(JSON.stringify(limited).includes(two.pageId),false);
  await grant(two.pageId,12);limited=await ok(await call(path,{account:reader}));assert.equal(limited.collection.records[0].values.sum,winner+3);assert.equal(limited.collection.records[0].values.count,2);await ok(await call(targetPath+'/records/'+two.id,{method:'DELETE',body:{expectedRevision:13}}));limited=await ok(await call(path,{account:reader}));assert.equal(limited.collection.records[0].values.sum,null);assert.equal(limited.collection.records[0].rollupErrors.sum.code,'ROLLUP_REDACTED_INPUT');await ok(await call(base+'/pages/'+two.pageId+'/restore',{method:'POST',body:{expectedRevision:14,parentId:target.pageId}}));
  await f.restart();const restored=await ok(await call(path+'/views/'+saved.viewId,{account:reader}));assert.equal(restored.revision,15);assert.equal(restored.collection.records[0].values.sum,winner+3);assert.equal(restored.collection.records[0].values.latest,'2026-10-16');assert.equal(restored.collection.properties.length,4);
  await ok(await call(targetPath,{method:'PATCH',body:{expectedRevision:15,properties:[{id:'due',name:'Due',type:'date'}],confirmPropertyDeletion:['amount']}}));const changed=await ok(await call(path,{account:reader}));assert.equal(changed.collection.records[0].values.sum,null);assert.deepEqual(changed.collection.records[0].rollupErrors.sum,{code:'ROLLUP_SOURCE_UNAVAILABLE'});assert.equal(changed.collection.records[0].values.count,2);
  const stored=await f.inspectD1("SELECT revision,json_extract(payload_json,'$.collections[1].collection.records[0].values.sum') AS sum,json_extract(payload_json,'$.collections[1].collection.records[0].values.count') AS count,json_array_length(json_extract(payload_json,'$.collections[1].collection.properties')) AS properties FROM yumunio_account_content");assert.deepEqual(stored,[{revision:16,sum:null,count:null,properties:4}]);
});
test('local workerd authors body page references with hidden span recovery and D1 persistence across restart',{timeout:240000},async t=>{
 const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,isolatedAssets:true});
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 async function register(name,count){const email='d1-body-ref-'+name+'@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Body reference '+name+' fixture'}}),202);const message=await relay.waitForCount(count),token=new URL(message.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const response=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(response),user=(await ok(response)).user;return{cookie,user,headers:{'X-Yumunio-Expected-Account':user.id}};}
 const owner=await register('owner',1),editor=await register('editor',2),workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie:owner.cookie,body:{name:'Body references D1 fixture',slug:'body-references-d1-fixture'}})),base='/api/content/workspaces/'+workspace.id;
 const call=(path,{method='GET',body,account=owner,headers={}}={})=>f.request(path,{method,body,cookie:account.cookie,headers:{...account.headers,...headers}});
 const target=await ok(await call(base+'/pages',{method:'POST',body:{expectedRevision:0,title:'Private target'}}),201),reference={start:0,end:6,label:'Target',pageId:target.page.id},block={id:'body',type:'paragraph',data:{text:'Target now',links:[reference]}},source=await ok(await call(base+'/pages',{method:'POST',body:{expectedRevision:1,title:'Reference source',blocks:[block]}}),201),path=base+'/pages/'+source.page.id;
 assert.equal((await ok(await call(base+'/pages/'+target.page.id+'/backlinks'))).sources[0].page.id,source.page.id);
 await ok(await call('/api/collaboration/workspaces/'+workspace.id+'/invitations',{method:'POST',body:{expectedRevision:2,requestId:'body-reference-editor',purpose:'page-guest',email:editor.user.email,role:'editor',pageId:source.page.id,includeDescendants:false}}),201);const message=await relay.waitForCount(3),link=new URL(message.text.split('\n').at(-1));await ok(await call('/api/collaboration/accept',{method:'POST',account:editor,body:{invitationId:link.searchParams.get('invite'),token:link.searchParams.get('token')}}));
 const hidden=await ok(await call(path,{account:editor}));assert.deepEqual(hidden.document.blocks[0].data.links,[{start:0,end:6,label:'Target',unavailable:true}]);assert.equal(JSON.stringify(hidden).includes(target.page.id),false);
 const prefixed={id:'body',type:'paragraph',data:{text:'New Target now',links:[{start:4,end:10,label:'Target',unavailable:true}]}};
 const saved=await ok(await call(path,{method:'PATCH',account:editor,body:{expectedRevision:4,expectedVersion:1,blocks:[prefixed]}}));assert.equal(saved.revision,5);assert.equal(JSON.stringify(saved).includes(target.page.id),false);
 const denied=await call(path,{method:'PATCH',account:editor,body:{expectedRevision:5,expectedVersion:2,blocks:[{id:'body',type:'paragraph',data:{text:'New Target now',links:[{start:4,end:10,label:'Target',pageId:target.page.id,fragment:'forged'}]}}]}});assert.equal(denied.status,404);await denied.arrayBuffer();
 const switched=await call(path,{method:'PATCH',account:editor,headers:owner.headers,body:{expectedRevision:5,expectedVersion:2,title:'Wrong actor'}});assert.equal(switched.status,404);await switched.arrayBuffer();
 await ok(await call(base+'/pages/'+target.page.id+'/grants',{method:'POST',body:{expectedRevision:5,accountId:editor.user.id,permission:'viewer'}}));
 await f.restart();const restored=await ok(await call(path,{account:editor}));assert.equal(restored.revision,6);assert.deepEqual(restored.document.blocks[0].data.links,[{start:4,end:10,label:'Target',pageId:target.page.id}]);assert.equal((await ok(await call(base+'/pages/'+target.page.id+'/backlinks',{account:editor}))).sources[0].references[0].snippet,'New Target now');
 const stale=await call(path,{method:'PATCH',account:editor,body:{expectedRevision:5,expectedVersion:2,title:'Stale'}});assert.equal(stale.status,409);await stale.arrayBuffer();
 await ok(await call(path,{method:'PATCH',account:editor,body:{expectedRevision:6,expectedVersion:2,blocks:[{id:'body',type:'paragraph',data:{text:'New Target now'}}]}}));assert.deepEqual((await ok(await call(base+'/pages/'+target.page.id+'/backlinks'))).sources,[]);
 const stored=await f.inspectD1("SELECT revision,json_extract(payload_json,'$.pages[1].document.blocks[0].data.links') AS links,json_extract(payload_json,'$.pages[1].document.version') AS version FROM yumunio_account_content");assert.deepEqual(stored,[{revision:7,links:null,version:3}]);
});
test('local workerd production factories fence scoped API tokens with real D1, SQL revocation and no external-read mail drain',{timeout:240000},async t=>{
 const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,isolatedAssets:true,apiTokens:true});
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 const email='d1-api-token-owner@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'API token D1 fixture'}}),202);const mail=await relay.waitForCount(1),verify=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(verify)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const signed=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(signed),user=(await ok(signed)).user,headers={'X-Yumunio-Expected-Account':user.id};
 const call=(path,{method='GET',body,extra={}}={})=>f.request(path,{method,body,cookie,headers:{...headers,...extra}}),workspace=await ok(await call('/api/auth/organization/create',{method:'POST',body:{name:'Scoped API D1 fixture',slug:'scoped-api-d1-fixture'}})),base='/api/content/workspaces/'+workspace.id;
 const page=await ok(await call(base+'/pages',{method:'POST',body:{expectedRevision:0,title:'API scoped page',blocks:[{id:'primary',type:'paragraph',data:{text:'Primary literal <b>body</b>',email:'private@studio.example'}},{id:'source',type:'code',data:{text:'Private original source',purpose:'import-source'}}]}}),201);
 const manage='/api/integrations/tokens',input={requestId:crypto.randomUUID(),expectedRevision:1,workspaceId:workspace.id,pageId:page.page.id,name:'Synthetic D1 reader',scopes:['page:read','document:read'],expiresAt:new Date(Date.now()+86400000).toISOString(),confirmPageAccess:true};
 assert.equal((await f.request(manage)).status,401);assert.equal((await call(manage,{extra:{'X-Yumunio-Expected-Account':'different-account'}})).status,404);assert.equal((await call(manage,{method:'POST',body:{...input,expectedRevision:0}})).status,409);
 const created=await ok(await call(manage,{method:'POST',body:input}),201);assert.match(created.token,/^yum_ro1\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);assert.equal(created.secretAvailable,true);const listed=await ok(await call(manage));assert.equal(listed.tokens.length,1);assert.doesNotMatch(JSON.stringify(listed),/yum_ro1\.|tokenHash|token_hash|requestDigest|membershipId/);const replay=await ok(await call(manage,{method:'POST',body:input}));assert.equal(replay.token,null);assert.equal(replay.secretAvailable,false);assert.equal(replay.metadata.id,created.metadata.id);assert.equal((await call(manage,{method:'POST',body:{...input,name:'Other intent'}})).status,409);
 const endpoint='/api/v1/pages/'+page.page.id,external=(path=endpoint,method='GET',token=created.token)=>f.request(path,{method,headers:{Authorization:'Bearer '+token,Cookie:'irrelevant=fake-cookie'}});
 const document=await ok(await external(endpoint+'/document'));assert.equal(document.document.blocks[0].data.text,'Primary literal <b>body</b>');assert.equal(document.document.blocks.length,1);assert.doesNotMatch(JSON.stringify(document),/Private original|private@studio|workspaceId|parentId|capabilities|memberships/);assert.equal((await external('/api/v1/pages/another-page')).status,401);assert.equal((await external(endpoint+'?token=forbidden')).status,404);assert.equal((await external(endpoint,'POST')).status,405);assert.equal((await f.request(endpoint)).status,401);
 const pageOnly=await ok(await call(manage,{method:'POST',body:{...input,requestId:crypto.randomUUID(),name:'Page-only D1 reader',scopes:['page:read']}}),201);assert.equal((await external(endpoint+'/document','GET',pageOnly.token)).status,401);assert.equal(Object.hasOwn(await ok(await external(endpoint,'GET',pageOnly.token)),'document'),false);assert.equal((await f.request('/api/workspace/snapshot',{headers:{Authorization:'Bearer '+created.token}})).status,401);
 await f.restart();assert.equal((await external(endpoint+'/document')).status,200);
 const control=async(mode,extra={})=>ok(await f.request('/api/__fixture/api-token-control',{method:'POST',body:{mode,accountId:user.id,workspaceId:workspace.id,pageId:page.page.id,...extra}}));
 for(const[deny,restore]of [['role-drop','role-restore'],['unverify','verify'],['replace-generation','restore-generation'],['deny-page','restore-page']]){await control(deny);assert.equal((await external()).status,401,deny);await control(restore);assert.equal((await external()).status,200,restore);}
 const current=await ok(await call(base+'/pages'));await control('block-mail');await ok(await call('/api/collaboration/workspaces/'+workspace.id+'/invitations',{method:'POST',body:{expectedRevision:current.revision,requestId:'api-token-drain-fence',purpose:'page-guest',email:'queued-api-fixture@studio.example',role:'viewer',pageId:page.page.id,includeDescendants:false}}),201);
 for(let index=0;index<30&&(await control('meter')).calls===0;index++)await delay(50);assert.ok((await control('meter')).calls>0);const queued=await control('due-mail');assert.ok(queued.queued>0);await ok(await external(endpoint+'/document'));await delay(150);const afterRead=await control('meter');assert.equal(afterRead.calls,0);assert.equal(afterRead.queued,queued.queued);
 await ok(await call('/api/auth/config'));for(let index=0;index<30&&(await control('meter')).calls===0;index++)await delay(50);assert.ok((await control('meter')).calls>0,'positive control must observe a normal request mail drain');
 assert.equal((await call(manage+'/'+created.metadata.id,{method:'DELETE',body:{expectedVersion:2}})).status,409);const revoked=await ok(await call(manage+'/'+created.metadata.id,{method:'DELETE',body:{expectedVersion:1}}));assert.equal(revoked.metadata.status,'revoked');assert.equal((await external()).status,401);await control('sql-revoke',{id:pageOnly.metadata.id});assert.equal((await external(endpoint,'GET',pageOnly.token)).status,401);
 await f.setApiTokens(false);const disabled=await ok(await call(manage));assert.equal(disabled.enabled,false);assert.equal((await f.request(manage)).status,401);assert.equal((await external()).status,503);await f.setApiTokens('yes');assert.equal((await f.request('/health')).status,503);assert.equal((await call(manage)).status,503);await f.setApiTokens(true);
 const stored=await f.inspectD1('SELECT COUNT(*) AS tokens,MIN(LENGTH(token_hash)) AS hash_length,SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,SUM(CASE WHEN active_slot IS NOT NULL THEN 1 ELSE 0 END) AS active FROM yumunio_api_tokens');assert.deepEqual(stored,[{tokens:2,hash_length:64,revoked:2,active:0}]);assert.equal((await external()).status,401);
});

test('local workerd personal templates copy authorized literals into private pages exactly once across D1 restart',{timeout:240000},async t=>{
 const relay=await localMailRelay(t),f=await fixture(t,{database:true,accounts:'open',relay,isolatedAssets:true});
 async function ok(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
 const email='d1-personal-templates@studio.example';await ok(await f.request('/api/auth/sign-up/email',{method:'POST',body:{email,password:authPassword,name:'Personal template fixture'}}),202);const mail=await relay.waitForCount(1),token=new URL(mail.text.split('\n').at(-1)).searchParams.get('verify');await ok(await f.request('/api/auth/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(f.origin+'/account')));const signed=await f.request('/api/auth/sign-in/email',{method:'POST',body:{email,password:authPassword}}),cookie=accountCookies(signed),user=(await ok(signed)).user,headers={'X-Yumunio-Expected-Account':user.id};
 const workspace=await ok(await f.request('/api/auth/organization/create',{method:'POST',cookie,body:{name:'Personal templates fixture',slug:'personal-templates-fixture'}})),base='/api/content/workspaces/'+workspace.id;
 const source=await ok(await f.request(base+'/pages',{method:'POST',cookie,headers,body:{expectedRevision:0,title:'Source template',blocks:[{id:'literal-source-id',type:'paragraph',data:{text:'Literal <b>safe</b>',marks:[{start:0,end:7,styles:['bold']}]}},{id:'private-original',type:'code',data:{text:'Do not copy raw source',purpose:'import-source'}}]}}),201),review=await ok(await f.request(base+'/pages/'+source.page.id+'/template-review',{method:'POST',cookie,headers,body:{expectedRevision:1}}));assert.equal(review.summary.blocksOmitted,1);assert.doesNotMatch(JSON.stringify(review.snapshot),/literal-source-id|private-original|Do not copy/);
 const createBody={expectedRevision:1,requestId:'11111111-1111-4111-8111-111111111111',sourcePageId:source.page.id,sourceVersion:1,reviewDigest:review.reviewDigest,name:'Personal copy',confirmSnapshot:true},created=await ok(await f.request(base+'/templates',{method:'POST',cookie,headers,body:createBody}),201),applyBody={expectedRevision:2,requestId:'22222222-2222-4222-8222-222222222222',title:'New private page',confirmPrivatePage:true},applied=await ok(await f.request(base+'/templates/'+created.templateId+'/applications',{method:'POST',cookie,headers,body:applyBody}),201);assert.equal(applied.deleted,false);
 const replay=await ok(await f.request(base+'/templates/'+created.templateId+'/applications',{method:'POST',cookie,headers,body:applyBody}));assert.equal(replay.pageId,applied.pageId);assert.equal(replay.replayed,true);const wrong=await f.request(base+'/templates/'+created.templateId+'/applications',{method:'POST',cookie,headers,body:{...applyBody,title:'Different'}});assert.equal(wrong.status,409);await wrong.arrayBuffer();const mismatch=await f.request(base+'/templates',{cookie,headers:{'X-Yumunio-Expected-Account':'another-account'}});assert.equal(mismatch.status,404);await mismatch.arrayBuffer();
 await f.restart();const list=await ok(await f.request(base+'/templates',{cookie,headers}));assert.equal(list.templates.length,1);const page=await ok(await f.request(base+'/pages/'+applied.pageId,{cookie,headers}));assert.equal(page.page.parentId,null);assert.equal(page.document.version,1);assert.equal(page.document.blocks.length,1);assert.equal(page.document.blocks[0].data.text,'Literal <b>safe</b>');assert.deepEqual(page.document.blocks[0].data.marks,[{start:0,end:7,styles:['bold']}]);assert.notEqual(page.document.blocks[0].id,'literal-source-id');const receipt=await ok(await f.request(base+'/template-requests/'+applyBody.requestId,{cookie,headers}));assert.equal(receipt.pageId,applied.pageId);assert.equal(receipt.replayed,true);
 await ok(await f.request(base+'/templates/'+created.templateId,{method:'DELETE',cookie,headers,body:{expectedRevision:3}}));const deletedReplay=await ok(await f.request(base+'/templates',{method:'POST',cookie,headers,body:createBody}));assert.equal(deletedReplay.deleted,true);const counts=await f.inspectD1("SELECT revision,json_array_length(json_extract(payload_json,'$.pages')) AS pages,json_array_length(json_extract(payload_json,'$.personalTemplates')) AS templates,json_array_length(json_extract(payload_json,'$.personalTemplateReceipts')) AS receipts,json_extract(payload_json,'$.pages[1].inheritPermissions') AS inherit FROM yumunio_account_content");assert.deepEqual(counts,[{revision:4,pages:2,templates:0,receipts:2,inherit:0}]);
});

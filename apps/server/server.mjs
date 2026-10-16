import {createBackupOperationsApi} from '@yumunio/backup/operations-api';
import {readServerAdminIds} from '@yumunio/identity/admin';
import { createServer } from 'node:http';
import { readFile, realpath, stat, mkdir } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspaceApi, MAX_BODY_BYTES } from '@yumunio/prototype';
import { isValidAccessKey, validatePublicOrigin } from '../../packages/prototype/src/config.js';
import { disabledIdentityResponse } from '@yumunio/identity';
import { MAX_BLOB_BYTES } from '../../packages/adapters/src/blob.js';
import { readServerConfig } from './config.mjs';
import { createInstanceApi } from '@yumunio/identity/instance';
import { createPwaManifestApi } from '@yumunio/identity/pwa';
import { createSqliteRecoveryStore, assertRecoveryReady } from '@yumunio/backup';

const defaultRoot = fileURLToPath(new URL('../../.build/web/', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'], ['.yaml', 'application/yaml; charset=utf-8']
]);
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
// Header names are case-insensitive; preserve Set-Cookie arrays while letting API policy replace static defaults.
const mergeHeaders=(...groups)=>Object.fromEntries(groups.flatMap(group=>Object.entries(group).map(([name,value])=>[name.toLowerCase(),value])));
const inside = (root, target) => {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};

/** Static host with an optional single-user snapshot API. */
export function createAppServer({ root = defaultRoot, snapshotStore = null, accessKey = '', publicOrigin = null, allowAnonymous = false, storage = snapshotStore ? 'sqlite' : 'browser-local', identity = null, instanceEnvironment = {}, backupOperations = null, recoveryStore = storage === 'sqlite' && snapshotStore?.database ? createSqliteRecoveryStore(snapshotStore.database) : null } = {}) {
  if (snapshotStore && !accessKey && !allowAnonymous) throw new Error('Persistence requires an access key or explicit loopback mode.');
  if (accessKey && !isValidAccessKey(accessKey)) throw new Error('Use an access key of 32 to 4096 characters.');
  if (publicOrigin) validatePublicOrigin(publicOrigin);
  if (snapshotStore && !accessKey && publicOrigin && !['127.0.0.1', 'localhost'].includes(new URL(publicOrigin).hostname)) throw new Error('Public-origin persistence requires an access key.');
  if (!['browser-local', 'sqlite', 'mariadb', 'mysql', 'tidb', 'postgres'].includes(storage) || Boolean(snapshotStore) !== (storage !== 'browser-local')) throw new Error('Storage selection must match the configured snapshot store.');
  if (identity && typeof identity.handle !== 'function') throw new Error('Expected an identity service handler.');
  const absoluteRoot = resolve(root);
  const apiByOrigin = new Map();
  const instanceByOrigin = new Map();
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) => {
      response.writeHead(status, mergeHeaders(headers,{'Content-Type':type},extraHeaders));
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { return send(400, 'Invalid request path'); }
    if (pathname === '/manifest.webmanifest') {
      if(!['GET','HEAD'].includes(request.method))return send(405,'Use GET or HEAD','text/plain; charset=utf-8',{Allow:'GET, HEAD'});
      const configuredOrigin=publicOrigin||('http://127.0.0.1:'+server.address().port);
      if(request.headers.host!==new URL(configuredOrigin).host)return send(403,'Untrusted Host');
      const manifest=await createPwaManifestApi({env:instanceEnvironment,origin:configuredOrigin})(new Request(new URL(request.url,configuredOrigin),{method:request.method,headers:request.headers}));
      return send(manifest.status,await manifest.text(),manifest.headers.get('content-type'),Object.fromEntries(manifest.headers));
    }
    if (pathname === '/health') {
      if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Use GET or HEAD');
      try { if (recoveryStore) await assertRecoveryReady(recoveryStore); }
      catch { return send(503, JSON.stringify({ status: 'recovery-unavailable', runtime: 'node', storage }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' }); }
      return send(200, JSON.stringify({ status: 'ok', runtime: 'node', prototype: true, storage }), 'application/json; charset=utf-8');
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const configuredOrigin = publicOrigin || ('http://127.0.0.1:' + server.address().port);
      if (request.headers.host !== new URL(configuredOrigin).host) return send(403, 'Untrusted Host');
      if (snapshotStore && !accessKey && allowAnonymous && !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(request.socket.remoteAddress)) return send(403, 'Anonymous persistence is restricted to loopback');
      try {
        try { if (recoveryStore) await assertRecoveryReady(recoveryStore); }
        catch (error) { return send(503, JSON.stringify({ error: { code: error?.code === 'RECOVERY_IN_PROGRESS' ? 'RECOVERY_IN_PROGRESS' : 'RECOVERY_UNAVAILABLE' } }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' }); }
        let body;
        if (!['GET', 'HEAD'].includes(request.method)) {
          const binaryUpload = request.method === 'PUT' && /^\/api\/content\/workspaces\/[A-Za-z0-9._:-]+\/(?:imports\/[A-Za-z0-9._:-]+|pages\/[A-Za-z0-9._:-]+\/uploads\/[A-Za-z0-9._:-]+)\/assets\/[A-Za-z0-9._:-]+$/.test(pathname);
          body = await boundedBody(request, binaryUpload ? MAX_BLOB_BYTES : MAX_BODY_BYTES);
        }
        const apiHeaders = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) apiHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const apiRequest = new Request(new URL(request.url, configuredOrigin), { method: request.method, headers: apiHeaders, ...(body ? { body } : {}) });
        let result;
        if (pathname === '/api/instance') {
          if (!instanceByOrigin.has(configuredOrigin)) instanceByOrigin.set(configuredOrigin, createInstanceApi({ env: instanceEnvironment, origin: configuredOrigin }));
          result = await instanceByOrigin.get(configuredOrigin)(apiRequest);
        } else if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
          result = identity ? await identity.handle(apiRequest, { peerAddress: request.socket.remoteAddress }) :
            pathname === '/api/auth/config' && request.method === 'GET' ? disabledIdentityResponse() :
            Response.json({ error: { code: 'ACCOUNTS_DISABLED', message: 'Account access is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (pathname === '/api/mcp' || pathname === '/api/integrations/mcp') {
          result=identity?.mcp?await identity.mcp(apiRequest):Response.json({error:{code:'MCP_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if (pathname === '/api/webhooks' || pathname.startsWith('/api/webhooks/')) {
          result=identity?.webhooks?(await identity.webhooks(apiRequest)??Response.json({error:{code:'WEBHOOK_NOT_FOUND'}},{status:404,headers:{'Cache-Control':'no-store'}})):Response.json({error:{code:'WEBHOOK_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if (pathname === '/api/integrations/tokens' || pathname.startsWith('/api/integrations/tokens/') || /^\/api\/v1(?:\/|$)/.test(pathname)) {
          result=identity?.apiTokens?await identity.apiTokens(apiRequest):Response.json({error:{code:'API_TOKENS_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if ((pathname === '/api/admin/backups' || pathname.startsWith('/api/admin/backups/cleanup/')) && backupOperations && identity?.auth) {
          result = await createBackupOperationsApi({operations:backupOperations,origin:configuredOrigin,adminIds:readServerAdminIds(instanceEnvironment),resolveSession:request=>identity.auth.api.getSession({headers:request.headers})})(apiRequest);
        } else if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
          result = identity?.admin ? await identity.admin(apiRequest) :
            Response.json({ error: { code: 'ADMIN_NOT_FOUND' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        } else if (pathname === '/api/preferences') {
          result = identity?.preferences ? await identity.preferences(apiRequest) :
            Response.json({ error: { code: 'PREFERENCES_UNAVAILABLE' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (pathname === '/api/collaboration' || pathname.startsWith('/api/collaboration/')) {
          result = identity?.collaboration ? await identity.collaboration.handle(apiRequest) :
            Response.json({ error: { code: 'COLLABORATION_UNAVAILABLE', message: 'Collaboration is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (pathname === '/api/content' || pathname.startsWith('/api/content/') || pathname === '/api/public' || pathname.startsWith('/api/public/')) {
          result = identity?.content ? await identity.content(apiRequest) :
            Response.json({ error: { code: 'CONTENT_UNAVAILABLE', message: 'Account content is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else {
          let api = apiByOrigin.get(configuredOrigin);
          if (!api) {
            api = createWorkspaceApi({ store: snapshotStore, storage, accessKey, allowAnonymous, origin: configuredOrigin });
            apiByOrigin.set(configuredOrigin, api);
          }
          result = await api(apiRequest);
        }
        const outgoing = mergeHeaders(headers,Object.fromEntries(result.headers));
        const cookies = result.headers.getSetCookie();
        if (cookies.length) outgoing['set-cookie'] = cookies;
        response.writeHead(result.status, outgoing);
        response.end(request.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        if (error.code === 'PAYLOAD_TOO_LARGE') {
          return send(413, JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the prototype size limit.' } }), 'application/json; charset=utf-8');
        }
        return send(500, JSON.stringify({ error: { code: 'SERVER_ERROR', message: 'Unable to process the request.' } }), 'application/json; charset=utf-8');
      }
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Method not allowed');
    }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.') && part !== '')) return send(404, 'Not found');
    const candidate = resolve(absoluteRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!inside(absoluteRoot, candidate)) return send(404, 'Not found');
    try {
      const [actualRoot, actualPath] = await Promise.all([realpath(absoluteRoot), realpath(candidate)]);
      if (!inside(actualRoot, actualPath)) return send(404, 'Not found');
      const info = await stat(actualPath);
      if (!info.isFile()) return send(404, 'Not found');
      const extension = extname(actualPath).toLowerCase();
      if (!contentTypes.has(extension)) return send(404, 'Not found');
      return send(200, await readFile(actualPath), contentTypes.get(extension));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return send(404, 'Not found');
      console.error('Static asset read failed:', error.code || error.name);
      return send(500, 'Unable to read the requested asset');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

function boundedBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(request.headers['content-length']);
    const limitError = () => Object.assign(new Error('Body limit'), { code: 'PAYLOAD_TOO_LARGE' });
    if (declared > maxBytes) { request.on('error', () => {}); request.resume(); return reject(limitError()); }
    const chunks = []; let size = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', aborted); };
    const failed = error => { cleanup(); reject(error); };
    const aborted = () => failed(new Error('Request aborted'));
    const data = chunk => {
      size += chunk.length;
      if (size > maxBytes) { cleanup(); request.on('error', () => {}); request.resume(); reject(limitError()); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', aborted);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let snapshotStore;
  let accountIdentity;
  let recoveryGuard;
  let backupService;
  let closing;
  const closeStore = () => closing ??= Promise.resolve().then(async()=>{try{await backupService?.close();}finally{await Promise.all([Promise.resolve().then(() => snapshotStore?.close()), accountIdentity?.close(), recoveryGuard?.close()]);}}).catch(() => {
    console.error('Unable to close the workspace database.');
    process.exitCode = 1;
  });
  try {
    const { port, host, storage, accessKey, publicOrigin, allowAnonymous, database, databaseOptions } = readServerConfig(process.env);
    if (storage === 'sqlite') {
      const { SqliteSnapshotStore } = await import('./snapshot-store.mjs');
      const databaseFile = resolve(database);
      await mkdir(dirname(databaseFile), { recursive: true });
      snapshotStore = new SqliteSnapshotStore(databaseFile);
    } else if (databaseOptions) {
      const { createDatabaseSnapshotStore } = await import('@yumunio/adapters/prototype-sql');
      snapshotStore = await createDatabaseSnapshotStore(databaseOptions);
    }
    const { createNodeRecoveryGuard } = await import('./recovery-gate.mjs');
    recoveryGuard = await createNodeRecoveryGuard({storage,databaseOptions},snapshotStore);
    if(databaseOptions)await snapshotStore.read(); // Fail before listening on invalid stored data.
    const {createNodeBackupService}=await import('./backup.mjs');
    backupService=await createNodeBackupService(process.env,{storage,database,databaseOptions},{snapshotStore,recoveryStore:recoveryGuard?.store});
    const { createNodeIdentityService } = await import('./identity.mjs');
    accountIdentity = await createNodeIdentityService(process.env, { storage, database, databaseOptions });
    const server = createAppServer({ snapshotStore, storage, accessKey, allowAnonymous, publicOrigin, identity: accountIdentity, instanceEnvironment: process.env, recoveryStore:recoveryGuard?.store, backupOperations:backupService?.operations });
    server.once('close', closeStore);
    server.on('error', () => {
      console.error('Unable to start Yumunio. Check the bind address and port.');
      process.exitCode = 1;
      void closeStore();
    });
    server.listen(port, host, () => { backupService?.start(); console.log('Yumunio prototype (' + storage + '): http://' + host + ':' + port); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch {
    console.error('Unable to initialize Yumunio. Check .env, database connectivity, TLS, and the schemas (npm run db:migrate / npm run auth:migrate).');
    process.exitCode = 1;
    await closeStore();
  }
}

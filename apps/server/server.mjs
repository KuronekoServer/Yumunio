import {createBackupOperationsApi} from '@yumunio/backup/operations-api';
import {webPageRoute} from '../../packages/prototype/src/web-routes.js';
import {readServerAdminIds} from '@yumunio/identity/admin';
import { createServer } from 'node:http';
import { realpath, stat, mkdir } from 'node:fs/promises';
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
import {attachRoomSockets} from './room-socket.mjs';
import {attachContentSockets} from './content-socket.mjs';
import {roomSocketScope} from '../../packages/identity/src/room-socket.js';
import {contentChangesPath} from '../../packages/identity/src/content-changes.js';
import {StaticAssetCache} from './static-assets.mjs';

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
export function createAppServer({ root = defaultRoot, snapshotStore = null, accessKey = '', publicOrigin = null, allowAnonymous = false, storage = snapshotStore ? 'sqlite' : 'browser-local', identity = null, instanceEnvironment = {}, backupOperations = null, recoveryStore = storage === 'sqlite' && snapshotStore?.database ? createSqliteRecoveryStore(snapshotStore.database) : null, runtimeProvider = null } = {}) {
  if (snapshotStore && !accessKey && !allowAnonymous) throw new Error('Persistence requires an access key or explicit loopback mode.');
  if (accessKey && !isValidAccessKey(accessKey)) throw new Error('Use an access key of 32 to 4096 characters.');
  if (publicOrigin) validatePublicOrigin(publicOrigin);
  if (snapshotStore && !accessKey && publicOrigin && !['127.0.0.1', 'localhost'].includes(new URL(publicOrigin).hostname)) throw new Error('Public-origin persistence requires an access key.');
  if (!['browser-local', 'sqlite', 'mariadb', 'mysql', 'tidb', 'postgres'].includes(storage) || Boolean(snapshotStore) !== (storage !== 'browser-local')) throw new Error('Storage selection must match the configured snapshot store.');
  if (identity && typeof identity.handle !== 'function') throw new Error('Expected an identity service handler.');
  const absoluteRoot = resolve(root);
  const apiByOrigin = new Map();
  const staticAssets=new StaticAssetCache();
  async function serveStatic(pathname,send){
    if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(part=>part.startsWith('.')&&part!==''))return send(404,'Not found');
    const route=webPageRoute(pathname),candidate=resolve(absoluteRoot,'.'+(route?.assetPath??pathname));
    if(!inside(absoluteRoot,candidate))return send(404,'Not found');
    try{
      const[actualRoot,actualPath]=await Promise.all([realpath(absoluteRoot),realpath(candidate)]);if(!inside(actualRoot,actualPath))return send(404,'Not found');
      const info=await stat(actualPath),extension=extname(actualPath).toLowerCase();if(!info.isFile()||!contentTypes.has(extension))return send(404,'Not found');
      return{actualPath,info,extension};
    }catch(error){if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))return send(404,'Not found');console.error('Static asset read failed:',error.code||error.name);return send(500,'Unable to read the requested asset');}
  }
  const baseRuntime = { accessKey, publicOrigin, identity, instanceEnvironment };
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) => {
      const socketOrigin=(runtime?.publicOrigin||'http://127.0.0.1:'+server.address().port).replace(/^http/,'ws');
      const detailUrl=new URL(request.url,'http://localhost'),isDetail=detailUrl.pathname==='/workspace-detail',frameAncestors=isDetail?"frame-ancestors 'self'":"frame-ancestors 'none'";if(isDetail)extraHeaders={...extraHeaders,'Cache-Control':'no-store'};
      response.writeHead(status, mergeHeaders({...headers,'Content-Security-Policy':headers['Content-Security-Policy'].replace("connect-src 'self'","connect-src 'self' "+socketOrigin).replace("frame-ancestors 'none'",frameAncestors)},{'Content-Type':type},extraHeaders));
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let runtime=baseRuntime,pathname;
    try{pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);}catch{return send(400,'Invalid request path');}
    // Repository-owned executable assets have no account or instance data. Do not open the
    // identity/database runtime for every chunk and stylesheet in a page's critical path.
    if(['GET','HEAD'].includes(request.method)&&/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|json|svg|png|ico|txt)|(?:_assets|_next\/static|shared|[a-z-]+-locales)\/.+)$/.test(pathname)){
      const file=await serveStatic(pathname,send);if(!file)return;
      try{const asset=await staticAssets.response(file.actualPath,file.info,request.headers,{compress:file.extension!=='.png'&&file.extension!=='.ico',immutable:/^\/(?:_assets|_next\/static)\//.test(pathname)});return send(asset.status,asset.status===304?undefined:asset.body,contentTypes.get(file.extension),asset.headers);}
      catch(error){console.error('Static asset read failed:',error.code||error.name);return send(500,'Unable to read the requested asset');}
    }
    try { runtime = runtimeProvider ? await runtimeProvider() : baseRuntime; }
    catch { return send(503, JSON.stringify({ error: { code: 'SETUP_UNAVAILABLE' } }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' }); }
    const { accessKey, publicOrigin, identity, instanceEnvironment, setupRequired, setup } = runtime;
    response.once('close', () => runtime.release?.());
    if (setup && pathname === '/') return send(302, '', 'text/plain; charset=utf-8', { Location: setupRequired ? '/setup' : '/account', 'Cache-Control': 'no-store' });
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
      return send(200, JSON.stringify({ status: setupRequired ? 'setup-required' : 'ok', runtime: 'node', prototype: true, storage }), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
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
        if (pathname === '/api/setup' || pathname === '/api/admin/settings') {
          result = setup ? await setup.handle(apiRequest) : Response.json({ enabled: false, error: { code: 'SETUP_DISABLED' } }, { status: pathname === '/api/setup' && request.method === 'GET' ? 200 : 404, headers: { 'Cache-Control': 'no-store' } });
        } else if (setupRequired && pathname !== '/api/instance') {
          result = Response.json({ error: { code: 'SETUP_REQUIRED' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (pathname === '/api/instance') {
          result = await createInstanceApi({ env: instanceEnvironment, origin: configuredOrigin })(apiRequest);
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
        if(result.ok&&!['GET','HEAD'].includes(request.method)&&pathname.startsWith('/api/content/'))await roomSockets.notify(pathname,pathname.endsWith('/presence')?'presence':'content');
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
    const route=webPageRoute(pathname);
    if(route?.redirectPath)return send(308,'','text/plain; charset=utf-8',{Location:route.redirectPath+new URL(request.url,'http://localhost').search,'Cache-Control':'no-store'});
    const file=await serveStatic(pathname,send);if(!file)return;
    try{const asset=await staticAssets.response(file.actualPath,file.info,request.headers,{compress:['.html','.js','.css','.json','.svg','.txt','.yaml'].includes(file.extension)});return send(asset.status,asset.status===304?undefined:asset.body,contentTypes.get(file.extension),asset.headers);}
    catch(error){console.error('Static asset read failed:',error.code||error.name);return send(500,'Unable to read the requested asset');}
  });
  const roomSockets=attachRoomSockets(server,{acquire:()=>runtimeProvider?runtimeProvider():baseRuntime,assertReady:async()=>{if(recoveryStore)await assertRecoveryReady(recoveryStore);}});
  attachContentSockets(server,{acquire:()=>runtimeProvider?runtimeProvider():baseRuntime,assertReady:async()=>{if(recoveryStore)await assertRecoveryReady(recoveryStore);}});
  server.on('upgrade',(request,socket)=>{try{const path=new URL(request.url,'http://localhost').pathname;if(roomSocketScope(path)||contentChangesPath(path))return;}catch{}socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
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
  let setupService;
  let closing;
  const closeStore = () => closing ??= Promise.resolve().then(async()=>{try{await backupService?.close();}finally{await Promise.all([Promise.resolve().then(() => snapshotStore?.close()), accountIdentity?.close(), recoveryGuard?.close(), setupService?.close()]);}}).catch(() => {
    console.error('Unable to close the workspace database.');
    process.exitCode = 1;
  });
  try {
    const { createNodeSetup } = await import('./setup.mjs');
    setupService = await createNodeSetup(process.env);
    const { port, host, storage, accessKey, publicOrigin, allowAnonymous, database, databaseOptions } = setupService?.config || readServerConfig(process.env);
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
    const runtimeEnvironment = setupService ? (await setupService.setup.load()).env : process.env;
    backupService=await createNodeBackupService(runtimeEnvironment,{storage,database,databaseOptions},{snapshotStore,recoveryStore:recoveryGuard?.store});
    const { createNodeIdentityService } = await import('./identity.mjs');
    accountIdentity = setupService ? null : await createNodeIdentityService(process.env, { storage, database, databaseOptions });
    const server = createAppServer({ snapshotStore, storage, accessKey, allowAnonymous, publicOrigin, identity: accountIdentity, instanceEnvironment: process.env, recoveryStore:recoveryGuard?.store, backupOperations:backupService?.operations, runtimeProvider: setupService ? () => setupService.acquire() : null });
    server.once('close', closeStore);
    server.on('error', () => {
      console.error('Unable to start Yumunio. Check the bind address and port.');
      process.exitCode = 1;
      void closeStore();
    });
    server.listen(port, host, async () => {
      backupService?.start(); console.log('Yumunio (' + storage + '): ' + publicOrigin);
      if (setupService && !(await setupService.setup.load()).data) console.log('初期設定をはじめる / Start setup: ' + setupService.setup.initialSetupUrl);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch {
    console.error('Unable to initialize Yumunio. Check .env, database connectivity, TLS, and the schemas (npm run db:migrate / npm run auth:migrate).');
    process.exitCode = 1;
    await closeStore();
  }
}

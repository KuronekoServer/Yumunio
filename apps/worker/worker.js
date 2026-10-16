import {readApiTokenConfig} from '@yumunio/identity/api-tokens';
import {readMcpConfig} from '@yumunio/identity/mcp';
import {readWebhookConfig} from '@yumunio/identity/webhooks-model';
import {createWorkerBackupOperations} from './backup.js';
import {readBackupConfig} from '@yumunio/backup/config';
import {backupBlobEnvironment} from '@yumunio/backup/operations';
import {readBlobConfig} from '../../packages/adapters/src/blob.js';
import { createWorkspaceApi } from '@yumunio/prototype';
import { D1SnapshotStore } from './snapshot-store.js';
import { isValidAccessKey, validatePublicOrigin } from '../../packages/prototype/src/config.js';
import { readIdentityConfig, disabledIdentityResponse } from '@yumunio/identity';
import { readMailConfig } from '@yumunio/identity/mail';
import { createWorkerAccountServices, drainWorkerMail } from './identity.js';
import { createInstanceApi } from '@yumunio/identity/instance';
import { createPwaManifestApi } from '@yumunio/identity/pwa';
import { createD1RecoveryStore, assertRecoveryReady } from '@yumunio/backup';

const policy = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

/** Shared UI, separate account identity and the legacy manual snapshot API. */
export default {
  async scheduled(_event, env, context) {
    if (env.DB) await assertRecoveryReady(createD1RecoveryStore(env.DB));
    const task = (async()=>{const operations=await createWorkerBackupOperations(env);try{await drainWorkerMail(env,context);await operations?.tick({steps:4});}finally{await operations?.close();}})();
    if (context?.waitUntil) context.waitUntil(task); else await task;
  },
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const configured = Boolean(env.DB);
    const storage = configured ? 'd1' : 'browser-local';
    let origin, identityConfig, mailConfig;
    let valid = true;
    try {
      origin = validatePublicOrigin(env.YUMUNIO_PUBLIC_ORIGIN || (configured ? '' : url.origin));
      if (configured && !isValidAccessKey(env.YUMUNIO_ACCESS_KEY)) valid = false;
      const backupConfig=readBackupConfig(env);
      if(backupConfig.enabled){if(!configured)throw new Error('Backup database required.');const target=readBlobConfig(backupBlobEnvironment(env),{runtime:'worker'});if(target.driver==='r2'&&!['get','put','delete'].every(method=>typeof env[target.binding]?.[method]==='function'))throw new Error('Backup R2 binding required.');await createD1RecoveryStore(env.DB).checkSchema();}
      identityConfig = readIdentityConfig(env);
      const apiTokenConfig=readApiTokenConfig(env);
      if(apiTokenConfig.enabled&&(!configured||!identityConfig.enabled))throw new Error('External API tokens require configured account storage.');
      const mcpConfig=readMcpConfig(env);
      if(mcpConfig.enabled&&(!configured||!identityConfig.enabled||!apiTokenConfig.enabled))throw new Error('MCP requires configured accounts and API tokens.');
      const webhookConfig=await readWebhookConfig(env);
      if(webhookConfig.enabled&&(!configured||!identityConfig.enabled))throw new Error('Webhooks require configured account storage.');
      if (identityConfig.enabled) {
        if (!configured) throw new Error('Account database required.');
        mailConfig = readMailConfig(env);
        if (mailConfig.driver === 'smtp' || (identityConfig.registrationMode === 'open' && mailConfig.driver === 'disabled')) throw new Error('Unsupported account email configuration.');
      }
    } catch { valid = false; }
    if (url.pathname === '/manifest.webmanifest') return createPwaManifestApi({env,origin:origin??url.origin})(request);
    if (url.pathname === '/health') {
      if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or HEAD.' } }, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store', ...policy } });
      try { if (env.DB) await assertRecoveryReady(createD1RecoveryStore(env.DB)); }
      catch { return new Response(request.method === 'HEAD' ? null : JSON.stringify({ status: 'recovery-unavailable', runtime: 'worker', storage }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...policy } }); }
      const body = { status: valid ? 'ok' : 'configuration-required', runtime: 'worker', prototype: true, storage };
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status: valid ? 200 : 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...policy } });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        if (!valid) throw new Error('Invalid deployment configuration');
        try { if (env.DB) await assertRecoveryReady(createD1RecoveryStore(env.DB)); }
        catch (error) { return Response.json({ error: { code: error?.code === 'RECOVERY_IN_PROGRESS' ? 'RECOVERY_IN_PROGRESS' : 'RECOVERY_UNAVAILABLE' } }, { status: 503, headers: { 'Cache-Control': 'no-store', ...policy } }); }
        const accountPath = /^\/api\/(?:auth|content|collaboration|preferences|admin|public|integrations|v1|webhooks|mcp)(?:\/|$)/.test(url.pathname);
        const services = identityConfig.enabled && accountPath ? await createWorkerAccountServices(env, identityConfig, context) : null;
        const identity = services?.identity;
        let result;
        if (url.pathname === '/api/instance') {
          result = await createInstanceApi({ env, origin })(request);
        } else if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
          if (identity) {
            result = await identity.handle(request, { peerAddress: request.headers.get('cf-connecting-ip') || 'unknown' });
          } else result = url.pathname === '/api/auth/config' && request.method === 'GET' ? disabledIdentityResponse() :
            Response.json({ error: { code: 'ACCOUNTS_DISABLED', message: 'Account access is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (url.pathname === '/api/mcp' || url.pathname === '/api/integrations/mcp') {
          result=services?.mcp?await services.mcp(request):Response.json({error:{code:'MCP_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if (url.pathname === '/api/webhooks' || url.pathname.startsWith('/api/webhooks/')) {
          result=services?.webhooks?(await services.webhooks(request)??Response.json({error:{code:'WEBHOOK_NOT_FOUND'}},{status:404,headers:{'Cache-Control':'no-store'}})):Response.json({error:{code:'WEBHOOK_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if (url.pathname === '/api/integrations/tokens' || url.pathname.startsWith('/api/integrations/tokens/') || /^\/api\/v1(?:\/|$)/.test(url.pathname)) {
          result=services?.apiTokens?await services.apiTokens(request):Response.json({error:{code:'API_TOKENS_DISABLED'}},{status:503,headers:{'Cache-Control':'no-store'}});
        } else if (url.pathname === '/api/admin/backups' || url.pathname.startsWith('/api/admin/backups/cleanup/')) {
          result=services?await services.backups(request):Response.json({error:{code:'ADMIN_NOT_FOUND'}},{status:404,headers:{'Cache-Control':'no-store'}});
        } else if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) {
          result = services ? await services.admin(request) :
            Response.json({ error: { code: 'ADMIN_NOT_FOUND' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        } else if (url.pathname === '/api/preferences') {
          result = services ? await services.preferences(request) :
            Response.json({ error: { code: 'PREFERENCES_UNAVAILABLE' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (url.pathname === '/api/collaboration' || url.pathname.startsWith('/api/collaboration/')) {
          result = services ? await services.collaboration.handle(request) :
            Response.json({ error: { code: 'COLLABORATION_UNAVAILABLE', message: 'Collaboration is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else if (url.pathname === '/api/content' || url.pathname.startsWith('/api/content/') || url.pathname === '/api/public' || url.pathname.startsWith('/api/public/')) {
          result = services ? await services.content(request) :
            Response.json({ error: { code: 'CONTENT_UNAVAILABLE', message: 'Account content is not configured.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        } else {
          const api = createWorkspaceApi({
            store: configured ? new D1SnapshotStore(env.DB) : null, storage,
            accessKey: configured ? (env.YUMUNIO_ACCESS_KEY || '') : '', allowAnonymous: false, origin
          });
          result = await api(request);
        }
        if (services && !/^\/api\/(?:v1|mcp)(?:\/|$)/.test(url.pathname)) {
          const jobs=[services.webhookJobs.runJobs()];if(mailConfig.driver!=='disabled')jobs.push(services.collaboration.runJobs());
          const drain = Promise.allSettled(jobs);
          if (context?.waitUntil) context.waitUntil(drain); else await drain;
        }
        for (const [name, value] of Object.entries(policy)) if (!result.headers.has(name)) result.headers.set(name, value);
        return result;
      } catch {
        return Response.json({ error: { code: 'SERVER_CONFIGURATION', message: 'Check the D1 binding, exact public origin, access key and account configuration.' } }, { status: 503, headers: { 'Cache-Control': 'no-store', ...policy } });
      }
    }
    // Keep explicit .html URLs usable by the service worker's redirect:error precache.
    // HTML handling is disabled; only the public root needs an index alias.
    let assetRequest = request;
    if (url.pathname === '/') {
      url.pathname = '/index.html';
      assetRequest = new Request(url, request);
    }
    const response = await env.ASSETS.fetch(assetRequest);
    const result = new Response(response.body, response);
    for (const [name, value] of Object.entries(policy)) result.headers.set(name, value);
    return result;
  }
};

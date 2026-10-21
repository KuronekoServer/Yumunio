import {createWebhookApi,createWebhookRunner} from '@yumunio/identity/webhooks';
import {readWebhookConfig} from '@yumunio/identity/webhooks-model';
import {createD1WebhookStore} from '@yumunio/identity/webhooks-store';
import {createApiTokenApi,readApiTokenConfig} from '@yumunio/identity/api-tokens';
import {createD1ApiTokenStore} from '@yumunio/identity/api-token-store';
import {createExternalPageActions} from '@yumunio/identity/external-page-actions';
import {createMcpApi,readMcpConfig} from '@yumunio/identity/mcp';
import {createWorkerBackupOperations} from './backup.js';
import {createBackupOperationsApi} from '@yumunio/backup/operations-api';
import { createIdentity, readIdentityConfig } from '@yumunio/identity';
import {readWorkerMailConfig,createWorkerMailer} from './mail.js';
import { createCollaborationService } from '@yumunio/identity/collaboration';
import { createD1CollaborationStore } from '@yumunio/identity/collaboration-store';
import { createAccountContentApi, validateContentPayload } from '@yumunio/identity/content';
import { createD1ContentStore } from '@yumunio/identity/content-store';
import {createD1RoomPresenceStore} from '@yumunio/identity/room-presence-store';
import { createWorkerBlobStore } from './blob-store.js';
import { createAdminApi, readServerAdminIds } from '@yumunio/identity/admin';
import { createD1AdminStore } from '@yumunio/identity/admin-store';
import { createPreferencesApi } from '@yumunio/identity/preferences';
import { createD1PreferencesStore } from '@yumunio/identity/preferences-store';

/** Request-scoped services; durable state and leases reside in D1. */
export async function createWorkerAccountServices(env, identityConfig = readIdentityConfig(env), context) {
  const apiTokenConfig=readApiTokenConfig(env);
  const mcpConfig=readMcpConfig(env);
  const webhookConfig=await readWebhookConfig(env),adminIds=readServerAdminIds(env);
  if(webhookConfig.enabled&&!identityConfig.enabled)throw new Error('Webhooks require configured accounts.');
  if(apiTokenConfig.enabled&&!identityConfig.enabled)throw new Error('External API tokens require configured accounts.');
  if(mcpConfig.enabled&&(!identityConfig.enabled||!apiTokenConfig.enabled))throw new Error('MCP requires configured accounts and API tokens.');
  if (!identityConfig.enabled) return null;
  if (!env.DB) throw new Error('Account database required.');
  const mailConfig = readWorkerMailConfig(env);
  if (identityConfig.registrationMode === 'open' && mailConfig.driver === 'disabled') throw new Error('Unsupported account email configuration.');
  const mailer = createWorkerMailer(mailConfig,env); let identity;
  const resolveSession = request => identity.auth.api.getSession({ headers: request.headers });
  const onCommit=(workspaceId)=>{
    if(!env.ROOMS)return;
    const task=env.ROOMS.get(env.ROOMS.idFromName('events:'+workspaceId)).fetch(new Request('https://events.internal/changed',{method:'POST'})).catch(()=>{});
    if(context?.waitUntil)context.waitUntil(task);return task;
  };
  const collaboration = createCollaborationService({ store: createD1CollaborationStore(env.DB,{onCommit}), origin: identityConfig.origin, secret: identityConfig.secret,
    domainPolicy: identityConfig.domainPolicy, resolveSession, sendMail: mailConfig.driver === 'disabled' ? undefined : message => mailer.send(message) });
  identity = createIdentity({ ...identityConfig, database: env.DB, workspaceContent: true,
    enqueueMail: mailConfig.driver === 'disabled' ? undefined : collaboration.enqueueMail,
    ...(context?.waitUntil ? { backgroundTask: task => context.waitUntil(task) } : {}) });
  const webhookStore=createD1WebhookStore(env.DB);
  if(webhookConfig.enabled)await webhookStore.checkSchema({eventTypes:webhookConfig.eventTypes,includeDescendants:webhookConfig.includeDescendants});
  const contentStore=createD1ContentStore(env.DB,{webhookStore,webhookConfig,webhookAdminIds:adminIds,validatePayload:validateContentPayload,onCommit}),apiTokenStore=createD1ApiTokenStore(env.DB);
  if(apiTokenConfig.enabled)await apiTokenStore.checkSchema();
  const actions=createExternalPageActions({store:apiTokenStore,contentStore,origin:identityConfig.origin,enabled:apiTokenConfig.enabled});
  const apiTokens=createApiTokenApi({store:apiTokenStore,contentStore,actions,origin:identityConfig.origin,enabled:apiTokenConfig.enabled,resolveSession});
  const mcp=createMcpApi({actions,origin:identityConfig.origin,enabled:mcpConfig.enabled,resolveSession});
  const content = createAccountContentApi({ instanceEnvironment:env, store: contentStore, origin: identityConfig.origin, blobStore: await createWorkerBlobStore(env), roomSecret: identityConfig.secret, roomPresenceStore:createD1RoomPresenceStore(env.DB), resolveSession });
  const preferences = createPreferencesApi({ store: createD1PreferencesStore(env.DB), origin: identityConfig.origin, resolveSession });
  const webhooks=createWebhookApi({config:webhookConfig,store:webhookStore,contentStore,origin:identityConfig.origin,adminIds,resolveSession});
  const webhookJobs=createWebhookRunner({config:webhookConfig,store:webhookStore,contentStore,adminIds});
  const admin = createAdminApi({ store: createD1AdminStore(env.DB,{adminIds}), adminIds, origin: identityConfig.origin, secret: identityConfig.secret, env, runtime: 'worker', storage: 'd1', resolveSession });
  return { identity, collaboration, content, preferences, admin, apiTokens, mcp, webhooks, webhookJobs, async backups(request){
    const operations=await createWorkerBackupOperations(env);
    const response=await createBackupOperationsApi({operations,origin:identityConfig.origin,adminIds,resolveSession})(request);
    const task=request.method==='POST'&&response.status===202?operations.tick({steps:4,schedule:false}).finally(()=>operations.close()):operations.close();
    if(context?.waitUntil)context.waitUntil(task);else await task;return response;
  } };
}
export async function drainWorkerMail(env, context) {
  const services = await createWorkerAccountServices(env, undefined, context);
  if (services) {await services.collaboration.runJobs({ limit: 50 });await services.webhookJobs.runJobs();}
}

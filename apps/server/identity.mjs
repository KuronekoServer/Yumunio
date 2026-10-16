import {createWebhookApi,createWebhookRunner} from '@yumunio/identity/webhooks';
import {readWebhookConfig} from '@yumunio/identity/webhooks-model';
import {createSqliteWebhookStore,createPoolWebhookStore,migrateWebhookEventSchema} from '@yumunio/identity/webhooks-store';
import {createApiTokenApi,readApiTokenConfig} from '@yumunio/identity/api-tokens';
import {createSqliteApiTokenStore,createPoolApiTokenStore,migrateApiTokenScopeSchema} from '@yumunio/identity/api-token-store';
import {createExternalPageActions} from '@yumunio/identity/external-page-actions';
import {createMcpApi,readMcpConfig} from '@yumunio/identity/mcp';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createIdentity, readIdentityConfig } from '@yumunio/identity';
import { readMailConfig } from '@yumunio/identity/mail';
import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';
import { createNodeMailer } from './mail.mjs';
import { createAccountContentApi, validateContentPayload } from '@yumunio/identity/content';
import { createSqliteContentStore, SqlAccountContentStore } from '@yumunio/identity/content-store';
import {createSqliteRoomPresenceStore,createPoolRoomPresenceStore} from '@yumunio/identity/room-presence-store';
import { createNodeBlobStore } from './blob-store.mjs';
import { createAdminApi, readServerAdminIds } from '@yumunio/identity/admin';
import { SqlAdminStore, createSqliteAdminStore } from '@yumunio/identity/admin-store';
import { createPreferencesApi } from '@yumunio/identity/preferences';
import { SqlPreferencesStore, createSqlitePreferencesStore } from '@yumunio/identity/preferences-store';
import { createCollaborationService } from '@yumunio/identity/collaboration';
import { createSqliteCollaborationStore, createPoolCollaborationStore } from '@yumunio/identity/collaboration-store';

/** Internal explicit migration step, shared with the maintained-DDL regression. */
export async function applyAccountCustomDdl({client,database}) {
  const dialect=client?.dialect||'sqlite';
  if(!['sqlite','mysql','postgres'].includes(dialect))throw new Error('Unsupported account schema dialect.');
  for(const kind of ['content','collaboration','preferences','api-tokens','webhooks','room-presence']) {
    const sql=await readFile(new URL('../../packages/identity/schema/'+kind+'.'+dialect+'.sql',import.meta.url),'utf8');
    // These maintained files contain no semicolons in literals. Remove full-line
    // comments before splitting: their prose may contain semicolons as punctuation.
    if(client)for(const statement of sql.replace(/^[\t ]*--[^\r\n]*$/gm,'').split(';').map(value=>value.trim()).filter(Boolean))await client.query(statement);
    else database.exec(sql);
  }
}

/** Open only configured account resources. Schema application is an explicit separate command. */
export async function createNodeIdentityService(env, serverConfig, { verifySchema = true, webhookFetch = fetch } = {}) {
  const config = readIdentityConfig(env);
  const apiTokenConfig=readApiTokenConfig(env);
  const mcpConfig=readMcpConfig(env);
  const webhookConfig=await readWebhookConfig(env),adminIds=readServerAdminIds(env);
  if(webhookConfig.enabled&&!config.enabled)throw new Error('Webhooks require configured accounts.');
  if(apiTokenConfig.enabled&&!config.enabled)throw new Error('External API tokens require configured accounts.');
  if(mcpConfig.enabled&&(!config.enabled||!apiTokenConfig.enabled))throw new Error('MCP requires configured accounts and API tokens.');
  if (!config.enabled) return null;
  if (serverConfig.storage === 'browser-local') throw new Error('Account storage requires a SQL database.');
  const mailConfig = readMailConfig(env);
  const mailer = createNodeMailer(mailConfig);
  let database, client, jobTimer, jobTask, collaboration, webhookRunner, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(jobTimer);
    await jobTask;
    await collaboration?.queue.flush();
    try { await mailer.close?.(); } finally { if (client) await client.end(); else database?.close(); }
  };
  try {
    if (serverConfig.storage === 'sqlite') {
      const filename = resolve(serverConfig.database);
      await mkdir(dirname(filename), { recursive: true });
      database = new DatabaseSync(filename, { timeout: 5000 });
    } else {
      client = await createDatabaseClient(serverConfig.databaseOptions);
      database = client.database;
    }
    const webhookStore=client?createPoolWebhookStore(client):createSqliteWebhookStore(database);
    const contentOptions={webhookStore,webhookConfig,webhookAdminIds:adminIds,validatePayload:validateContentPayload};
    const contentStore = client ? new SqlAccountContentStore(client,contentOptions) : createSqliteContentStore(database,contentOptions);
    const roomPresenceStore=client?createPoolRoomPresenceStore(client):createSqliteRoomPresenceStore(database);
    const preferencesStore = client ? new SqlPreferencesStore(client) : createSqlitePreferencesStore(database);
    const collaborationStore = client ? createPoolCollaborationStore(client) : createSqliteCollaborationStore(database);
    const apiTokenStore=client?createPoolApiTokenStore(client):createSqliteApiTokenStore(database);
    let identity;
    collaboration = createCollaborationService({ store: collaborationStore, origin: config.origin, secret: config.secret, domainPolicy: config.domainPolicy,
      resolveSession: request => identity.auth.api.getSession({ headers: request.headers }),
      sendMail: mailConfig.driver === 'disabled' ? undefined : message => mailer.send(message) });
    identity = createIdentity({ ...config, database, workspaceContent: true, enqueueMail: mailConfig.driver === 'disabled' ? undefined : collaboration.enqueueMail });
    const startJobs = () => {
      if (closed || jobTimer || mailConfig.driver === 'disabled' && !webhookConfig.enabled) return;
      const drain = () => { if (!closed && !jobTask) {const tasks=[];if(mailConfig.driver!=='disabled')tasks.push(collaboration.runJobs());if(webhookRunner)tasks.push(webhookRunner.runJobs());jobTask=Promise.allSettled(tasks).finally(()=>{jobTask=null;});} };
      jobTimer = setInterval(drain, 15000); jobTimer.unref(); drain();
    };
    if (verifySchema) {
      const { getMigrations } = await import('better-auth/db/migration');
      const plan = await getMigrations(identity.auth.options);
      if (plan.toBeCreated.length || plan.toBeAdded.length || plan.toBeAddedIndexes.length || plan.schemaProblems.length || plan.unsafeChanges.length) throw new Error('Account schema requires an explicit migration.');
      try { await contentStore.checkSchema(); await collaborationStore.checkSchema(); await preferencesStore.checkSchema();if(apiTokenConfig.enabled)await apiTokenStore.checkSchema();if(webhookConfig.enabled)await webhookStore.checkSchema({eventTypes:webhookConfig.eventTypes,includeDescendants:webhookConfig.includeDescendants}); } catch { throw new Error('Account content schema (including enabled integrations) requires an explicit migration.'); }
    }
    const blobStore = await createNodeBlobStore(env);
    const content = createAccountContentApi({ store: contentStore, origin: config.origin, blobStore, roomSecret: config.secret, roomPresenceStore,
      resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
    const preferences = createPreferencesApi({ store: preferencesStore, origin: config.origin, resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
    const actions=createExternalPageActions({store:apiTokenStore,contentStore,origin:config.origin,enabled:apiTokenConfig.enabled});
    const apiTokens=createApiTokenApi({store:apiTokenStore,contentStore,actions,origin:config.origin,enabled:apiTokenConfig.enabled,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
    const mcp=createMcpApi({actions,origin:config.origin,enabled:mcpConfig.enabled,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
    const webhooks=createWebhookApi({config:webhookConfig,store:webhookStore,contentStore,origin:config.origin,adminIds,resolveSession:request=>identity.auth.api.getSession({headers:request.headers})});
    webhookRunner=createWebhookRunner({config:webhookConfig,store:webhookStore,contentStore,adminIds,fetcher:webhookFetch});
    const adminStore = client ? new SqlAdminStore(client,{adminIds}) : createSqliteAdminStore(database,{adminIds});
    const admin = createAdminApi({ store: adminStore, adminIds, origin: config.origin, secret: config.secret, env, runtime: 'node', storage: serverConfig.storage,
      resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
    if(verifySchema)startJobs();
    return { ...identity, content, collaboration, preferences, admin, apiTokens, mcp, webhooks, webhookJobs:webhookRunner,
      async migrateContentSchema() {
        const dialect = client?.dialect || 'sqlite';
        await applyAccountCustomDdl({client,database});
        const migration={dialect,database,...(client?{query:client.query.bind(client)}:{})};
        await migrateApiTokenScopeSchema(migration);
        await migrateWebhookEventSchema(migration);
        await roomPresenceStore.checkSchema();
        await contentStore.checkSchema(); await collaborationStore.checkSchema();await preferencesStore.checkSchema();if(apiTokenConfig.enabled)await apiTokenStore.checkSchema();if(webhookConfig.enabled)await webhookStore.checkSchema({eventTypes:webhookConfig.eventTypes,includeDescendants:webhookConfig.includeDescendants}); startJobs();
      },
      close: async () => { await identity.flushBackgroundTasks?.(); await close(); } };
  } catch (error) { await close(); throw error; }
}

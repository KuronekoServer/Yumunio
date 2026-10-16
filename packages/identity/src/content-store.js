import {principalSnapshotGuardSql} from './content-principal-guard.js';
import {pruneInlineMentionNotifications} from './content-activity.js';
import {encodeContentPayload,readContentPayload,contentChunkCommands} from './content-codec.js';
import {createContentBatch} from './content-batch.js';
import { assertId } from '@yumunio/domain';
import {externalTokenGuardSql} from './external-token-guard.js';
import {buildWorkspaceWebhookCommands} from './webhooks-lifecycle.js';
import {webhookSubscriptionSnapshotSql} from './webhooks-commands.js';

const MAX_PRINCIPALS = 1000;
const MAX_GUARDS = 16;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const roles = ['owner', 'admin', 'member', 'guest'];

/** Fixed messages deliberately omit SQL, identity records and stored content. */
export class ContentStoreError extends Error {
  constructor(code) {
    super(code === 'CONTENT_CONFLICT' ? 'Account content changed before it could be saved.' :
      code === 'CONTENT_NOT_FOUND' ? 'Account content is unavailable.' : 'The account content database operation failed.');
    this.name = 'ContentStoreError';
    this.code = code;
  }
}
const storageError = () => new ContentStoreError('CONTENT_STORAGE_ERROR');
const conflict = () => new ContentStoreError('CONTENT_CONFLICT');
const missing = () => new ContentStoreError('CONTENT_NOT_FOUND');

function identifier(value) {
  try { return assertId(value); } catch { throw storageError(); }
}
function role(value) {
  if (!roles.includes(value)) throw storageError();
  return value;
}
function revision(value) {
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) value = Number(value);
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(MAX_REVISION)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 1) throw storageError();
  return value;
}
function verified(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw storageError();
}
/** All SQL fragments originate here; caller data is bound, including every ID and role. */
function sqlContext(dialect) {
  const params = [];
  const bind = value => { params.push(value); return dialect === 'postgres' ? '$' + params.length : '?'; };
  const column = (alias, name) => alias + '.' + (dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"');
  // SDK-owned MySQL tables may use a case-insensitive collation. Identity checks must be exact.
  const equal = (left, right) => dialect === 'mysql' ? 'BINARY ' + left + ' = BINARY ' + right : left + ' = ' + right;
  const membershipCount = alias => '(SELECT COUNT(*) FROM yumunio_memberships mc WHERE ' +
    equal(column('mc', 'organizationId'), column(alias, 'organizationId')) + ' AND ' +
    equal(column('mc', 'userId'), column(alias, 'userId')) + ') = 1';
  const canonicalRole = alias => '(' + roles.map(value => equal(column(alias, 'role'), "'" + value + "'")).join(' OR ') + ')';
  const joinUser = alias => ' JOIN yumunio_users ' + alias + 'u ON ' + equal(column(alias + 'u', 'id'), column(alias, 'userId'));
  const actor = (workspaceId, accountId, membershipId, actorRole) => 'EXISTS (SELECT 1 FROM yumunio_memberships a' +
    joinUser('a') + ' JOIN yumunio_workspaces w ON ' + equal(column('w', 'id'), column('a', 'organizationId')) +
    ' WHERE ' + equal(column('a', 'organizationId'), bind(workspaceId)) +
    ' AND ' + equal(column('a', 'userId'), bind(accountId)) +
    ' AND ' + equal(column('a', 'id'), bind(membershipId)) +
    ' AND ' + equal(column('a', 'role'), bind(actorRole)) +
    ' AND ' + column('au', 'emailVerified') + ' = TRUE AND ' + canonicalRole('a') +
    ' AND ' + membershipCount('a') + ')';
  const guard = (workspaceId, value) => 'EXISTS (SELECT 1 FROM yumunio_memberships g' + joinUser('g') +
    ' WHERE ' + equal(column('g', 'organizationId'), bind(workspaceId)) +
    ' AND ' + equal(column('g', 'id'), bind(value.id)) +
    ' AND ' + equal(column('g', 'userId'), bind(value.accountId)) +
    ' AND ' + equal(column('g', 'role'), bind(value.role)) +
    ' AND ' + column('gu', 'emailVerified') + ' = TRUE AND ' + canonicalRole('g') +
    ' AND ' + membershipCount('g') + ')';
  return { params, bind, column, equal, membershipCount, canonicalRole, joinUser, actor, guard };
}

/**
 * Private aggregate persistence, not a public snapshot API. Page authorization and
 * Domain validation belong to the page service; membership and CAS are rechecked
 * in the same SQL mutation. Chunk writes use a caller-owned atomic batch.
 */
export class SqlAccountContentStore {
  #dialect;
  #query;
  #webhooks;
  #batch;
  #chunkReady;

  constructor(client, options = {}) {
    if (!client || !['sqlite', 'mysql', 'postgres'].includes(client.dialect) || typeof client.query !== 'function') throw storageError();
    this.#dialect = client.dialect;
    this.#query = client.query.bind(client);
    this.#batch=createContentBatch(client);
    if(options.webhookConfig?.enabled){
      if(options.webhookStore?.dialect!==client.dialect||!['subscriptions','approval','commitContent'].every(key=>typeof options.webhookStore[key]==='function')||typeof options.validatePayload!=='function'||!(options.webhookAdminIds instanceof Set)&&!Array.isArray(options.webhookAdminIds))throw storageError();
      this.#webhooks={store:options.webhookStore,config:options.webhookConfig,adminIds:new Set(options.webhookAdminIds),validatePayload:options.validatePayload,now:options.webhookNow??(()=>new Date().toISOString())};
      if(typeof this.#webhooks.now!=='function')throw storageError();
    }
  }

  async #execute(sql, params = [], duplicateIsConflict = false) {
    try {
      const result = await this.#query(sql, params);
      if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0) throw storageError();
      return result;
    } catch (cause) {
      if (duplicateIsConflict && (cause?.code === 'ER_DUP_ENTRY' || cause?.errno === 1062)) return { rows: [], affectedRows: 0 };
      throw storageError();
    }
  }

  /** Checks presence only. Migrations must be applied explicitly by the deployment operator. */
  async checkSchema() {
    await this.#execute('SELECT workspace_id, revision, payload_json FROM yumunio_account_content WHERE 1 = 0');
    this.#chunkReady=undefined;await this.#chunkSchema();
  }

  async #chunkSchema(){
    if(this.#chunkReady===undefined){try{await this.#execute('SELECT workspace_id,revision,ordinal,payload_text FROM yumunio_content_chunks WHERE 1 = 0');await this.#execute('SELECT id,ok FROM yumunio_content_guards WHERE 1 = 0');this.#chunkReady=true;}catch{this.#chunkReady=false;}}
    return this.#chunkReady;
  }

  /**
   * Returns null for a missing workspace, unverified actor or ambiguous membership.
   * One SELECT captures authorization, the head and all principals. Chunk data
   * is fetched only for that still-current revision, or the entire read fails.
   */
  async read(workspaceId, accountId) {
    identifier(workspaceId); identifier(accountId);
    const s = sqlContext(this.#dialect);
    const isActor = s.equal(s.column('m', 'id'), s.column('a', 'id'));
    const sql = 'SELECT c.workspace_id AS content_workspace_id, c.revision AS revision, ' +
      'CASE WHEN ' + isActor + ' THEN c.payload_json ELSE NULL END AS payload_json, ' +
      'CASE WHEN ' + isActor + ' THEN 1 ELSE 0 END AS is_actor, ' +
      s.column('m', 'id') + ' AS membership_id, ' + s.column('mu', 'id') + ' AS account_id, ' +
      s.column('mu', 'email') + ' AS email, ' + s.column('mu', 'name') + ' AS display_name, ' + s.column('mu', 'emailVerified') + ' AS email_verified, ' +
      s.column('m', 'role') + ' AS role FROM yumunio_workspaces w ' +
      'JOIN yumunio_memberships a ON ' + s.equal(s.column('a', 'organizationId'), s.column('w', 'id')) + s.joinUser('a') +
      ' LEFT JOIN yumunio_account_content c ON ' + s.equal('c.workspace_id', s.column('w', 'id')) +
      ' JOIN yumunio_memberships m ON ' + s.equal(s.column('m', 'organizationId'), s.column('w', 'id')) + s.joinUser('m') +
      ' WHERE ' + s.equal(s.column('w', 'id'), s.bind(workspaceId)) +
      ' AND ' + s.equal(s.column('a', 'userId'), s.bind(accountId)) +
      ' AND ' + s.column('au', 'emailVerified') + ' = TRUE AND ' + s.canonicalRole('a') +
      ' AND ' + s.membershipCount('a') + ' AND ' + s.canonicalRole('m') + ' AND ' + s.membershipCount('m') +
      ' ORDER BY ' + s.column('m', 'id') + ' LIMIT ' + (MAX_PRINCIPALS + 1);
    const { rows } = await this.#execute(sql, s.params);
    if (!rows.length) return null;
    if (rows.length > MAX_PRINCIPALS) throw storageError();
    try {
      const actorRows = rows.filter(row => row.is_actor === 1 || row.is_actor === 1n);
      if (actorRows.length !== 1) throw storageError();
      const actor = actorRows[0];
      const principals = rows.map(row => {
        if (typeof row.email !== 'string' || row.email.length > 254 || /[\u0000-\u0020\u007f]/.test(row.email)) throw storageError();
        const displayName = typeof row.display_name === 'string' ? Array.from(row.display_name.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 240).join('') : '';
        return { id: identifier(row.membership_id), accountId: identifier(row.account_id), displayName: displayName || identifier(row.account_id), email: row.email,
          emailVerified: verified(row.email_verified), role: role(row.role) };
      });
      if (principals.find(row => row.accountId === accountId)?.emailVerified !== true) throw storageError();
      if (actor.content_workspace_id === null) {
        if (rows.some(row => row.content_workspace_id !== null || row.revision !== null || row.payload_json !== null)) throw storageError();
        return { revision: 0, payload: null, principals };
      }
      if (actor.content_workspace_id !== workspaceId) throw storageError();
      const currentRevision = revision(actor.revision);
      if (rows.some(row => row.content_workspace_id !== workspaceId || revision(row.revision) !== currentRevision ||
          (row !== actor && row.payload_json !== null))) throw storageError();
      return { revision: currentRevision, payload: await readContentPayload((...args)=>this.#execute(...args),this.#dialect,workspaceId,currentRevision,actor.payload_json), principals };
    } catch { throw storageError(); }
  }

  /**
   * Privileged internal publication lookup, never a session or HTTP content API.
   * Call only after validating an encrypted publication locator. The publication
   * service must revalidate the stored token, publisher generation and page ACL.
   * UNION includes the private aggregate once and live principals in the same
   * statement snapshot; anonymous callers never receive this internal result.
   */
  async readPublication(workspaceId) {
    identifier(workspaceId);
    const s = sqlContext(this.#dialect);
    const sql = 'SELECT 0 AS row_kind, c.workspace_id AS content_workspace_id, c.revision AS revision, c.payload_json AS payload_json, ' +
      'NULL AS membership_id, NULL AS account_id, NULL AS email, NULL AS display_name, NULL AS email_verified, NULL AS role ' +
      'FROM yumunio_workspaces w JOIN yumunio_account_content c ON ' + s.equal('c.workspace_id',s.column('w','id')) +
      ' WHERE ' + s.equal(s.column('w','id'),s.bind(workspaceId)) +
      ' UNION ALL SELECT 1 AS row_kind, NULL, NULL, NULL, ' + s.column('m','id') + ', ' + s.column('mu','id') + ', ' +
      s.column('mu','email') + ', ' + s.column('mu','name') + ', ' + s.column('mu','emailVerified') + ', ' + s.column('m','role') +
      ' FROM yumunio_workspaces w JOIN yumunio_memberships m ON ' + s.equal(s.column('m','organizationId'),s.column('w','id')) + s.joinUser('m') +
      ' WHERE ' + s.equal(s.column('w','id'),s.bind(workspaceId)) + ' AND ' + s.canonicalRole('m') + ' AND ' + s.membershipCount('m') +
      ' ORDER BY row_kind, membership_id LIMIT ' + (MAX_PRINCIPALS + 2);
    const {rows} = await this.#execute(sql,s.params);
    if (rows.length > MAX_PRINCIPALS + 1) throw storageError();
    const contents = rows.filter(row=>row.row_kind===0||row.row_kind===0n);
    if (!contents.length) return null;
    try {
      if (contents.length!==1||contents[0].content_workspace_id!==workspaceId) throw storageError();
      const content=contents[0],principals=[];
      for (const row of rows) {
        if (row===content) continue;
        if ((row.row_kind!==1&&row.row_kind!==1n)||row.content_workspace_id!==null||row.payload_json!==null||row.revision!==null||
            typeof row.email!=='string'||row.email.length>254||/[\u0000-\u0020\u007f]/.test(row.email)) throw storageError();
        const displayName=typeof row.display_name==='string'?Array.from(row.display_name.replace(/[\u0000-\u001f\u007f]/g,'').trim()).slice(0,240).join(''):'';
        principals.push({id:identifier(row.membership_id),accountId:identifier(row.account_id),displayName:displayName||identifier(row.account_id),email:row.email,emailVerified:verified(row.email_verified),role:role(row.role)});
      }
      const currentRevision=revision(content.revision);return {revision:currentRevision,payload:await readContentPayload((...args)=>this.#execute(...args),this.#dialect,workspaceId,currentRevision,content.payload_json),principals};
    } catch { throw storageError(); }
  }

  /** No retries: a lost response may have committed, so the caller must read and reauthorize. */
  async write(workspaceId, accountId, { expectedRevision, payload, actorMembershipId, actorRole, guardMemberships = [], tokenGuard = null, guardPrincipalSnapshot = null } = {}) {
    identifier(workspaceId); identifier(accountId); identifier(actorMembershipId); role(actorRole);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= MAX_REVISION) throw conflict();
    if (!Array.isArray(guardMemberships) || guardMemberships.length > MAX_GUARDS) throw storageError();
    const guards = guardMemberships.map(value => {
      if (!value || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'accountId') || !Object.hasOwn(value, 'role')) throw storageError();
      return { id: identifier(value.id), accountId: identifier(value.accountId), role: role(value.role) };
    });
    let encoded;try{
      // Work on a captured value: non-notifying body changes retire old receipts in the same CAS,
      // without mutating their caller or allowing a later undo/restore to resurrect an old unread item.
      if(Array.isArray(payload?.activityNotifications)&&payload.activityNotifications.some(item=>item?.kind==='inline-mention')){payload=structuredClone(payload);pruneInlineMentionNotifications(payload);}
      encoded=encodeContentPayload(payload,expectedRevision+1);
    }catch{throw storageError();}
    const text=encoded.head,transport=!!(this.#batch||this.#webhooks)&&await this.#chunkSchema();
    if(encoded.chunks.length&&!transport)throw storageError();
    let subscriptionRows,webhookCommands=[];
    if(this.#webhooks){
      const hook=this.#webhooks;
      try{
        const saved=await this.read(workspaceId,accountId);
        if(!saved)throw missing();
        if(saved.revision!==expectedRevision)throw conflict();
        const checked=hook.validatePayload(payload,workspaceId);
        subscriptionRows=await hook.store.subscriptions(workspaceId);
        if(saved.payload){
          const approval=await hook.store.approval(hook.config.profileHash),currentApproval=approval&&hook.adminIds.has(approval.approvedBy)?approval:null,stamp=hook.now();
          webhookCommands=await buildWorkspaceWebhookCommands({dialect:this.#dialect,workspaceId,saved,checked,subscriptions:subscriptionRows,config:hook.config,approval:currentApproval,validatePayload:hook.validatePayload,now:stamp});
        }
      }catch(error){if(error instanceof ContentStoreError)throw error;throw storageError();}
    }
    const s = sqlContext(this.#dialect);
    let sql;
    if (expectedRevision === 0) {
      sql = 'INSERT INTO yumunio_account_content (workspace_id, revision, payload_json) SELECT ' + s.bind(workspaceId) + ', 1, ' + s.bind(text) + ' WHERE ';
    } else {
      sql = 'UPDATE yumunio_account_content SET revision = revision + 1, payload_json = ' + s.bind(text) +
        ' WHERE ' + s.equal('workspace_id', s.bind(workspaceId)) + ' AND revision = ' + s.bind(expectedRevision) +
        ' AND revision < 9007199254740991 AND ';
    }
    sql += s.actor(workspaceId, accountId, actorMembershipId, actorRole);
    if(!transport&&expectedRevision>0)sql+=' AND payload_json NOT LIKE \'{"$yumunioContent":1,%\'';
    for (const guard of guards) sql += ' AND ' + s.guard(workspaceId, guard);
    if(guardPrincipalSnapshot!==null){try{sql+=' AND '+principalSnapshotGuardSql(s,this.#dialect,workspaceId,guardPrincipalSnapshot);}catch{throw storageError();}}
    if(tokenGuard!==null){try{if(expectedRevision===0)throw storageError();sql+=' AND '+externalTokenGuardSql(s,this.#dialect,tokenGuard,{workspaceId,accountId,actorMembershipId,actorRole});}catch{throw storageError();}}
    if(this.#webhooks)sql+=' AND '+webhookSubscriptionSnapshotSql(s,this.#dialect,workspaceId,subscriptionRows);
    if (expectedRevision === 0 && this.#dialect !== 'mysql') sql += ' ON CONFLICT (workspace_id) DO NOTHING';
    let result;
    if(this.#webhooks){
      try{await this.#webhooks.store.commitContent({contentCommand:{sql,params:s.params,expectChanges:1},commands:[...(transport?contentChunkCommands(this.#dialect,{workspaceId,revision:expectedRevision+1,chunks:encoded.chunks}):[]),...webhookCommands]});result={rows:[],affectedRows:1};}
      catch(error){if(error?.code==='WEBHOOK_CONFLICT'){if(!await this.read(workspaceId,accountId))throw missing();throw conflict();}throw storageError();}
    }else if(transport){
      try{await this.#batch([{sql,params:s.params,expectChanges:1},...contentChunkCommands(this.#dialect,{workspaceId,revision:expectedRevision+1,chunks:encoded.chunks})]);result={rows:[],affectedRows:1};}
      catch(error){if(error?.code==='CONTENT_CONFLICT'||error?.code==='ER_DUP_ENTRY'||error?.errno===1062){if(!await this.read(workspaceId,accountId))throw missing();throw conflict();}throw storageError();}
    }else result=await this.#execute(sql,s.params,expectedRevision===0&&this.#dialect==='mysql');
    if (result.affectedRows === 1) return { revision: expectedRevision + 1 };
    if (result.affectedRows !== 0) throw storageError();
    if (!await this.read(workspaceId, accountId)) throw missing();
    throw conflict();
  }
}

/** Uses a caller-owned node:sqlite DatabaseSync; this factory never creates schema or closes it. */
export function createSqliteContentStore(database, options) {
  if (!database || typeof database.prepare !== 'function') throw storageError();
  const execute=({sql,params=[]})=>{const statement=database.prepare(sql);return /^\s*SELECT\b/i.test(sql)?{rows:statement.all(...params),affectedRows:0}:{rows:[],affectedRows:Number(statement.run(...params).changes)};};
  return new SqlAccountContentStore({ dialect:'sqlite',async query(sql,params=[]){return execute({sql,params});},async batch(commands){database.exec('BEGIN IMMEDIATE');try{const results=commands.map(command=>{const result=execute(command);if(command.expectChanges!==undefined&&result.affectedRows!==command.expectChanges)throw conflict();return result;});database.exec('COMMIT');return results;}catch(error){try{database.exec('ROLLBACK');}catch{}throw error;}}},options);
}

/** D1 prepared statements; chunk changes and their CAS guard share one atomic batch. */
export function createD1ContentStore(database, options) {
  if (!database || typeof database.prepare !== 'function') throw storageError();
  const prepare=command=>database.prepare(command.sql).bind(...(command.params??[]));
  const normalize=result=>{if(!result||result.success===false||!Array.isArray(result.results)||!Number.isSafeInteger(result.meta?.changes))throw storageError();return{rows:result.results,affectedRows:result.meta.changes};};
  return new SqlAccountContentStore({ dialect: 'sqlite', async query(sql, params = []) {
    const result = await database.prepare(sql).bind(...params).all();
    return normalize(result);
  },...(typeof database.batch==='function'?{async batch(commands){const expanded=[],indexes=[];for(const command of commands){indexes.push(expanded.length);expanded.push(command);if(command.expectChanges!==undefined){const id=crypto.randomUUID();expanded.push({sql:'INSERT INTO yumunio_content_guards(id,ok) VALUES(?,CASE WHEN changes()=? THEN 1 ELSE 0 END)',params:[id,command.expectChanges]},{sql:'DELETE FROM yumunio_content_guards WHERE id=?',params:[id]});}}try{const results=(await database.batch(expanded.map(prepare))).map(normalize);return indexes.map(index=>results[index]);}catch(error){if(/yumunio_content_guards|CHECK constraint failed: ok/i.test(error?.message??''))throw conflict();throw error;}}}:{})},options);
}

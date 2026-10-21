import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {parseDocument,isAlias,visit as visitYaml} from 'yaml';
import {Validator} from '@cfworker/json-schema';
import {TEAMSPACE_LIMITS,TEAMSPACE_VISIBILITIES,TEAMSPACE_ROLES,TEAMSPACE_PERMISSIONS} from '../../domain/src/teamspaces.js';
import {API_TOKEN_SCOPE_SETS,API_TOKEN_LIMITS,validateTokenCreate,projectTokenPage} from '../../identity/src/api-token-model.js';
import {createApiTokenApi} from '../../identity/src/api-tokens.js';
import {createExternalPageActions} from '../../identity/src/external-page-actions.js';
import {createSqliteApiTokenStore} from '../../identity/src/api-token-store.js';
import {createSqliteContentStore} from '../../identity/src/content-store.js';
import {createAccountContentApi,validateContentPayload} from '../../identity/src/content.js';
import {createSqliteRoomPresenceStore} from '../../identity/src/room-presence-store.js';
import {ROOM_LIMITS,Y,fromBase64,toBase64,loadRoomDocument,loadStructuredRoom,structuredRoomOperation,structuredRoomText,structuredRoomReferences,structuredRoomFormat} from '@yumunio/collaboration';
import {PRESENCE_LIMITS} from '@yumunio/collaboration/presence';
import {createMcpApi,MCP_PROTOCOL_VERSION} from '../../identity/src/mcp.js';
import {createWebhookApi} from '../../identity/src/webhooks.js';
import {createSqliteWebhookStore} from '../../identity/src/webhooks-store.js';
import {WEBHOOK_EVENT_TYPES,WEBHOOK_LIMITS,readWebhookConfig,validateWebhookEvent,webhookRetryDelay} from '../../identity/src/webhooks-model.js';
import {signWebhookEvent,verifyWebhookSignature} from '../../identity/src/webhooks-transport.js';

const source=await readFile(new URL('../../../openapi.yaml',import.meta.url),'utf8');
const parsed=parseDocument(source,{strict:true,uniqueKeys:true,version:'1.2'}),spec=parsed.toJS({maxAliasCount:0});
const identitySchema=await readFile(new URL('../../../apps/worker/auth-schema.sql',import.meta.url),'utf8');
const methods=['get','post','put','patch','delete','options','head','trace'];
const origin='https://openapi-fixture.example.invalid';
function resolve(value){if(!value?.$ref)return value;assert.match(value.$ref,/^#\//);return value.$ref.slice(2).split('/').reduce((item,key)=>{assert.ok(item&&Object.hasOwn(item,key),'Unresolved '+value.$ref);return item[key];},spec);}
const validator=schema=>new Validator({...schema,components:spec.components},'2020-12',false);
function matches(schema,value){const result=validator(schema).validate(value);assert.equal(result.valid,true,JSON.stringify(result.errors));return value;}
const schema=name=>spec.components.schemas[name];
function requestMatches(path,method,value){return matches(resolve(spec.paths[path][method].requestBody).content['application/json'].schema,value);}
async function responseMatches(path,method,response,status=200){assert.equal(response.status,status,await response.clone().text());const selected=resolve(spec.paths[path][method].responses[String(status)]);assert.ok(selected,'Undocumented status '+status+' '+method+' '+path);assert.match(response.headers.get('cache-control'),/no-store/);return matches(selected.content['application/json'].schema,await response.json());}

function fixture(t,{sourceBlock=false,roomEnabled=true,presenceEnabled=true}={}){
 const db=new DatabaseSync(':memory:');db.exec(identitySchema);t.after(()=>db.close());const stamp=new Date().toISOString();
 for(const id of ['owner','admin']){
  db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);
  db.prepare('INSERT INTO yumunio_auth_sessions(id,expiresAt,token,createdAt,updatedAt,userId)VALUES(?,?,?,?,?,?)').run('session-'+id,Date.parse(stamp)+3600000,'synthetic-session-'+id,Date.parse(stamp),Date.parse(stamp),id);
 }
 db.prepare('INSERT INTO yumunio_workspaces(id,name,slug,createdAt)VALUES(?,?,?,?)').run('workspace','OpenAPI fixture','openapi-fixture',stamp);
 db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership','workspace','owner','owner',stamp);
 const adminIds=new Set(['admin']),configPromise=readWebhookConfig({YUMUNIO_WEBHOOK_ENABLED:'true',YUMUNIO_WEBHOOK_ENDPOINT:'https://receiver.example.invalid/events',YUMUNIO_WEBHOOK_SIGNING_KEY:btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),YUMUNIO_WEBHOOK_EVENTS:WEBHOOK_EVENT_TYPES.join(',')});
 const payload={schemaVersion:1,pages:[{page:{id:'page',workspaceId:'workspace',parentId:null,title:'Original title',createdAt:stamp,updatedAt:stamp,trashedAt:null},document:{pageId:'page',workspaceId:'workspace',version:1,updatedAt:stamp,blocks:[{id:'body',type:'paragraph',data:{text:'Original body',objectKey:'private-fixture-metadata'}},...(sourceBlock?[{id:'source',type:'code',data:{text:'Private source archive',purpose:'import-source'}}]:[])]},inheritPermissions:false}],grants:[{id:'grant',workspaceId:'workspace',pageId:'page',accountId:'owner',permission:'full',includeDescendants:false,status:'active'}],grantBindings:[{grantId:'grant',membershipId:'membership'}]};
 let time=stamp;
 const ready=(async()=>{
  const config=await configPromise,webhookStore=createSqliteWebhookStore(db),content=createSqliteContentStore(db,{webhookConfig:config,webhookStore,webhookAdminIds:adminIds,validatePayload:validateContentPayload});
  await content.write('workspace','owner',{expectedRevision:0,payload,actorMembershipId:'membership',actorRole:'owner'});
  const resolveSession=async request=>{const id=request.headers.get('x-fixture-account'),user=db.prepare('SELECT id,emailVerified FROM yumunio_users WHERE id=?').get(id??'');return user?.emailVerified?{session:{id:'session-'+id},user:{id,emailVerified:true}}:null;},tokens=createSqliteApiTokenStore(db),actions=createExternalPageActions({store:tokens,contentStore:content,origin,enabled:true});
  const tokenApi=createApiTokenApi({store:tokens,contentStore:content,actions,origin,enabled:true,resolveSession}),webhooks=createWebhookApi({config,store:webhookStore,contentStore:content,origin,adminIds,resolveSession}),mcp=createMcpApi({actions,origin,enabled:true,resolveSession});
  const contentApi=createAccountContentApi({store:content,origin,resolveSession,now:()=>time,roomSecret:roomEnabled?'Synthetic room documentation signing secret':null,roomPresenceStore:presenceEnabled?createSqliteRoomPresenceStore(db):null});
  return{config,content,webhookStore,tokenApi,webhooks,mcp,contentApi};
 })();
 const request=async(path,{method='GET',body,account='owner',authorization,headers={}}={})=>{const services=await ready,api=path.startsWith('/api/content/')||path.startsWith('/api/public/forms/')?services.contentApi:path.startsWith('/api/webhooks/')?services.webhooks:path==='/api/integrations/mcp'?services.mcp:services.tokenApi;return api(new Request(origin+path,{method,headers:{...(account?{'X-Fixture-Account':account,'X-Yumunio-Expected-Account':account}:{}),...(authorization?{Authorization:authorization}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));};
 const intent=()=>({requestId:crypto.randomUUID(),expectedRevision:1,workspaceId:'workspace',pageId:'page',name:'Synthetic docs credential',scopes:[...API_TOKEN_SCOPE_SETS.at(-1)],expiresAt:new Date(Date.now()+86400000).toISOString(),confirmPageAccess:true});
 const issue=async()=>{const input=intent();requestMatches('/api/integrations/tokens','post',input);return responseMatches('/api/integrations/tokens','post',await request('/api/integrations/tokens',{method:'POST',body:input}),201);};
 return{db,ready,request,intent,issue,setTime:value=>{time=value;}};
}

test('OpenAPI YAML parses without duplicate keys, resolves local references and documents only the supported integration and selected account subset',()=>{
 assert.deepEqual(parsed.errors,[]);assert.deepEqual(parsed.warnings,[]);assert.equal(spec.openapi,'3.1.0');assert.equal(spec.servers[0].url,'/');
 visitYaml(parsed,(_key,node)=>{assert.equal(isAlias(node),false,'Aliases are not used in the published specification.');if(node&&typeof node==='object')assert.equal(Boolean(node.anchor),false,'Anchors are not used in the published specification.');});
 const expected={
  '/api/admin/backups/cleanup/preview':['post'],'/api/admin/backups/cleanup/approval':['post','delete'],'/api/admin/backups/cleanup/jobs':['get'],
  '/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}/requests':['get','post','patch','delete'],
  '/api/content/workspaces/{workspaceId}/pages/{pageId}/grants':['get','post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/grants/{grantId}':['delete'],
  '/api/content/workspaces/{workspaceId}/collections/{collectionId}/property-conversions/preview':['post'],'/api/content/workspaces/{workspaceId}/collections/{collectionId}/property-conversions':['post'],
  '/api/content/workspaces/{workspaceId}/groups':['get','post'],'/api/content/workspaces/{workspaceId}/groups/{groupId}':['get','patch'],'/api/content/workspaces/{workspaceId}/groups/{groupId}/members':['post','delete'],'/api/content/workspaces/{workspaceId}/groups/{groupId}/archive':['post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/group-grants':['get','post','delete'],
  '/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}/duplicate':['post'],
  "/api/content/workspaces/{workspaceId}/teamspaces":["get","post"],"/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}":["get","patch"],"/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}/members":["post","delete"],"/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}/join":["post"],"/api/content/workspaces/{workspaceId}/teamspaces/{teamspaceId}/archive":["post"],"/api/content/workspaces/{workspaceId}/pages/{pageId}/teamspace-review":["post"],"/api/content/workspaces/{workspaceId}/pages/{pageId}/teamspace":["patch"],
  '/api/v1/pages/{pageId}':['get'],'/api/v1/pages/{pageId}/document':['get','patch'],'/api/integrations/tokens':['get','post'],'/api/integrations/tokens/{tokenId}':['delete'],'/api/integrations/mcp':['get'],'/api/webhooks/config':['get'],'/api/webhooks/approval':['post','delete'],'/api/webhooks/workspaces/{workspaceId}/pages/{pageId}/subscription':['get','post','delete'],'/api/webhooks/workspaces/{workspaceId}/pages/{pageId}/deliveries':['get'],'/api/webhooks/workspaces/{workspaceId}/pages/{pageId}/deliveries/{eventId}':['delete'],
  '/api/content/workspaces/{workspaceId}/pages/{pageId}/room':['get'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/room/open':['post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/room/updates':['post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/room/renew':['post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/room/presence':['get','post','delete'],
  '/api/content/workspaces/{workspaceId}/pages/{pageId}/blocks/move':['post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/people':['get'],'/api/content/workspaces/{workspaceId}/notifications':['get','post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/comments':['get','post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/comments/{threadId}':['get','post'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/comments/{threadId}/messages/{messageId}':['patch','delete'],'/api/content/workspaces/{workspaceId}/pages/{pageId}/comments/{threadId}/resolve':['patch']
 };
 expected['/api/content/workspaces/{workspaceId}/pages/{pageId}/room/ws']=['get'];
 expected['/api/v1/pages/{pageId}/blocks']=['patch'];expected['/api/public/forms/{token}']=['get'];expected['/api/public/forms/{token}/responses']=['post'];
 assert.deepEqual(Object.keys(spec.paths).sort(),Object.keys(expected).sort());const operationIds=new Set();
 for(const[path,item]of Object.entries(spec.paths)){
  assert.deepEqual(Object.keys(item).filter(key=>methods.includes(key)).sort(),expected[path].sort());
  for(const method of expected[path]){const operation=item[method];assert.ok(operation.operationId);assert.equal(operationIds.has(operation.operationId),false);operationIds.add(operation.operationId);assert.ok(operation.responses['200']||operation.responses['201']||path.endsWith('/room/ws')&&operation.responses['101']);assert.equal(operation['x-reject-query'],true);
   const parameters=[...(item.parameters??[]),...(operation.parameters??[])].map(resolve);for(const variable of path.matchAll(/\{([^}]+)\}/g))assert.ok(parameters.some(value=>value.in==='path'&&value.name===variable[1]&&value.required));
  }
 }
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.$ref)resolve(value);Object.values(value).forEach(visit);};visit(spec);
 assert.equal(operationIds.size,71);assert.equal(Object.keys(spec.components.schemas).length,149);assert.equal(Object.hasOwn(spec.paths,'/api/mcp'),false);assert.equal(spec['x-mcp-transport'].endpoint,'/api/mcp');assert.equal(Object.hasOwn(spec['x-mcp-transport'],'x-docs-file'),false);assert.equal(spec['x-mcp-transport'].protocolVersion,MCP_PROTOCOL_VERSION);assert.ok(spec.webhooks.pageUpdateMetadata.post);assert.equal(operationIds.has(spec.webhooks.pageUpdateMetadata.post.operationId),false);
});

test('documented private inbox union separates minimal page references from comment excerpts',()=>{
 const notice={id:'inline-mention',pageId:'page',pageTitle:'Literal <page>',authorId:'author',createdAt:'2026-10-16T00:00:00.000Z',readAt:null,reason:'inline-mention'};
 matches(schema('InboxResponse'),{revision:1,notifications:[notice,{...notice,id:'assignment',reason:'assignment'}]});
 for(const extra of [{text:'Private body'},{threadId:'thread'},{blockId:'block'},{recipientId:'account'},{recipientMembershipId:'generation'}])assert.equal(validator(schema('InboxResponse')).validate({revision:1,notifications:[{...notice,...extra}]}).valid,false);
 assert.equal(validator(schema('InboxResponse')).validate({revision:1,notifications:[{...notice,reason:'unknown'}]}).valid,false);
});

test('documented text conversion reviews and commits real SQLite values while invalid dates preserve all data',async t=>{
 const f=fixture(t),root='/api/content/workspaces/workspace/collections',template='/api/content/workspaces/{workspaceId}/collections/{collectionId}/property-conversions';await f.ready;
 const createdResponse=await f.request(root,{method:'POST',body:{expectedRevision:1,title:'Conversion contract',parentId:null,properties:[{id:'amount',name:'Amount',type:'text'},{id:'date',name:'Date',type:'text'}]}});assert.equal(createdResponse.status,201);const created=await createdResponse.json(),path=root+'/'+created.collectionId;
 for(const values of [{amount:'1200',date:'2026-10-16'},{amount:'0.1',date:'2026-02-30'}]){const result=await f.request(path+'/records',{method:'POST',body:{expectedRevision:(await fixtureState(f)).revision,title:'Synthetic row',values}});assert.equal(result.status,201);}
 const body={expectedRevision:(await fixtureState(f)).revision,sourcePropertyId:'amount',targetType:'number',name:' Numeric amount '},before=await fixtureState(f);requestMatches(template+'/preview','post',body);
 const preview=await responseMatches(template+'/preview','post',await f.request(path+'/property-conversions/preview',{method:'POST',body}));assert.equal(preview.valid,true);assert.equal(preview.name,'Numeric amount');assert.deepEqual(preview.rows.map(row=>row.value),[1200,0.1]);assert.deepEqual(await fixtureState(f),before);
 const command={...body,previewDigest:preview.previewDigest,confirm:true};requestMatches(template,'post',command);const acknowledgement=await responseMatches(template,'post',await f.request(path+'/property-conversions',{method:'POST',body:command}));assert.equal(acknowledgement.convertedCount,2);
 const collection=(await fixtureState(f)).payload.collections.find(item=>item.collection.id===created.collectionId).collection;assert.equal(collection.properties.find(item=>item.id===acknowledgement.propertyId).type,'number');assert.deepEqual(collection.records.map(row=>row.values.amount),['1200','0.1']);
 const dateBody={expectedRevision:acknowledgement.revision,sourcePropertyId:'date',targetType:'date',name:'Calendar date'};requestMatches(template+'/preview','post',dateBody);const datePreview=await responseMatches(template+'/preview','post',await f.request(path+'/property-conversions/preview',{method:'POST',body:dateBody}));assert.equal(datePreview.valid,false);assert.equal(datePreview.invalidCount,1);assert.equal(datePreview.rows[1].error,'CONVERSION_INVALID_DATE');
 const preserved=await fixtureState(f),rejected=await responseMatches(template,'post',await f.request(path+'/property-conversions',{method:'POST',body:{...dateBody,previewDigest:datePreview.previewDigest,confirm:true}}),409);assert.equal(rejected.error.code,'PROPERTY_CONVERSION_INVALID_VALUES');assert.deepEqual(await fixtureState(f),preserved);
 await responseMatches(template+'/preview','post',await f.request(path+'/property-conversions/preview',{method:'POST',body:dateBody,headers:{Origin:'https://other.example.invalid'}}),403);
 assert.equal(validator(schema('TextPropertyConversionCommitRequest')).validate({...command,confirm:false}).valid,false);
});

test('documented individual sharing validates current scope and actual SQLite ACKs',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);const path=accountBase+'/pages/page/grants',template=accountTemplate+'/pages/{pageId}/grants';
 await responseMatches(template,'get',await f.request(path));const assigned=await documentedTeamspaceMutation(f,path,template,{accountId:'participant',permission:'editor',includeDescendants:true});assert.equal(assigned.grant.includeDescendants,true);assert.equal((await f.request(accountBase+'/pages/page',{account:'participant'})).status,200);
 const replaced=await documentedTeamspaceMutation(f,path,template,{accountId:'participant',permission:'viewer'});assert.equal(replaced.grant.includeDescendants,false);await documentedTeamspaceMutation(f,path+'/'+replaced.grant.id,template+'/{grantId}',{},{method:'DELETE'});assert.equal((await f.request(accountBase+'/pages/page',{account:'participant'})).status,404);
 for(const includeDescendants of ['all',null,1])assert.equal(validator(schema('IndividualPageGrantRequest')).validate({expectedRevision:1,accountId:'participant',permission:'viewer',includeDescendants}).valid,false);
});

test('documented teamspace requests validate real SQLite request, cancel, reject and approve ACKs',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);const team=await documentedTeamspaceCreate(f,{visibility:'closed'}),path=accountBase+'/teamspaces/'+team.teamspace.id+'/requests',template=teamspaceTemplate+'/requests';
 const empty=await responseMatches(template,'get',await f.request(path,{account:'participant'}));assert.equal(empty.canRequest,true);assert.equal(empty.myRequest,null);
 const first=await documentedTeamspaceMutation(f,path,template,{confirmRequest:true},{account:'participant'});assert.equal(first.action,'request');const own=await responseMatches(template,'get',await f.request(path,{account:'participant'}));assert.equal(own.myRequest.id,first.requestId);assert.deepEqual(own.requests,[]);
 await documentedTeamspaceMutation(f,path,template,{requestId:first.requestId,confirmCancel:true},{method:'DELETE',account:'participant'});
 const second=await documentedTeamspaceMutation(f,path,template,{confirmRequest:true},{account:'participant'});await documentedTeamspaceMutation(f,path,template,{requestId:second.requestId,accountId:'participant',decision:'reject',confirmAccessChange:true},{method:'PATCH'});
 const third=await documentedTeamspaceMutation(f,path,template,{confirmRequest:true},{account:'participant'});const queue=await responseMatches(template,'get',await f.request(path));assert.equal(queue.requests[0].id,third.requestId);await documentedTeamspaceMutation(f,path,template,{requestId:third.requestId,accountId:'participant',decision:'approve',confirmAccessChange:true},{method:'PATCH'});assert.equal((await responseMatches(template,'get',await f.request(path))).requests.length,0);
 assert.equal(validator(schema('TeamspaceJoinRequestDecisionRequest')).validate({expectedRevision:1,requestId:'r',accountId:'a',decision:'approve',role:'owner',confirmAccessChange:true}).valid,false);
});

test('documented group operations validate actual SQLite membership, explicit grants, revocation and archive DTOs',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);const base=accountBase+'/groups',template=accountTemplate+'/groups',details=template+'/{groupId}',page=accountTemplate+'/pages/{pageId}/group-grants';
 await responseMatches(template,'get',await f.request(base));const created=await documentedTeamspaceMutation(f,base,template,{name:'Reviewers'}),path=base+'/'+created.group.id;
 await responseMatches(details,'get',await f.request(path));await documentedTeamspaceMutation(f,path,details,{name:'Editors',confirmAccessChange:true},{method:'PATCH'});
 const added=await documentedTeamspaceMutation(f,path+'/members',details+'/members',{accountId:'participant',confirmAccessChange:true});assert.equal(added.group.memberCount,1);
 await documentedTeamspaceMutation(f,accountBase+'/pages/page/group-grants',page,{groupId:created.group.id,permission:'editor',includeDescendants:false,confirmAccessChange:true});await responseMatches(page,'get',await f.request(accountBase+'/pages/page/group-grants'));assert.equal((await f.request(accountBase+'/pages/page',{account:'participant'})).status,200);
 const grants=await(await f.request(accountBase+'/pages/page/group-grants')).json();await documentedTeamspaceMutation(f,accountBase+'/pages/page/group-grants',page,{grantId:grants.grants[0].id,confirmAccessChange:true},{method:'DELETE'});assert.equal((await f.request(accountBase+'/pages/page',{account:'participant'})).status,404);
 await documentedTeamspaceMutation(f,path+'/members',details+'/members',{memberId:added.members[0].id,confirmAccessChange:true},{method:'DELETE'});await documentedTeamspaceMutation(f,path+'/archive',details+'/archive',{archived:true,confirmAccessChange:true});
 const bad={expectedRevision:(await fixtureState(f)).revision,accountId:'participant',confirmAccessChange:true};requestMatches(details+'/members','post',bad);await responseMatches(details+'/members','post',await f.request(path+'/members',{method:'POST',body:bad}),409);
 for(const name of [' leading','trailing ','line\nbreak',' '])assert.equal(validator(schema('GroupCreateRequest')).validate({expectedRevision:1,name}).valid,false);
});

test('public Bearer scopes and same-origin cookie/admin guards stay distinct in every documented operation',()=>{
 for(const[path,item]of Object.entries(spec.paths))for(const method of methods.filter(key=>Object.hasOwn(item,key))){
  const operation=item[method],parameters=[...(item.parameters??[]),...(operation.parameters??[])].map(resolve);
  if(path.startsWith('/api/v1/')){assert.deepEqual(operation.security,[{PersonalToken:[]}]);assert.equal(parameters.some(value=>value.name==='X-Yumunio-Expected-Account'),false);assert.ok(operation['x-required-scopes'].every(value=>['page:read','document:read','document:write'].includes(value)));}
  else if(path.startsWith('/api/public/forms/')){assert.deepEqual(operation.security,[]);assert.equal(operation['x-audience'],'anonymous-capability');assert.equal(parameters.some(value=>value.name==='X-Yumunio-Expected-Account'),false);if(method==='post')assert.ok(parameters.some(value=>value.name==='Origin'&&value.required));}
  else if(path.endsWith('/room/ws')){assert.deepEqual(operation.security,[{SessionCookie:[]},{SecureSessionCookie:[]}]);assert.ok(parameters.some(value=>value.name==='Origin'&&value.required));assert.equal(parameters.some(value=>value.name==='X-Yumunio-Expected-Account'),false);assert.ok(operation.responses['101']);assert.match(operation.description,/first frame must read state/);}
  else{assert.deepEqual(operation.security,[{SessionCookie:[]},{SecureSessionCookie:[]}]);assert.ok(parameters.some(value=>value.name==='X-Yumunio-Expected-Account'&&(value.required||/\/pages\/\{pageId\}\/grants/.test(path))));if(['post','delete','patch'].includes(method))assert.ok(parameters.some(value=>value.name==='Origin'&&value.required));}
 }
 assert.equal(spec.components.securitySchemes.PersonalToken.scheme,'bearer');assert.equal(spec.components.securitySchemes.SessionCookie.name,'yumunio.account.session_token');assert.equal(spec.components.securitySchemes.SecureSessionCookie.name,'__Secure-yumunio.account.session_token');
 assert.equal(spec.paths['/api/webhooks/approval'].post['x-audience'],'server-admin');assert.equal(spec.paths['/api/webhooks/workspaces/{workspaceId}/pages/{pageId}/subscription'].post['x-required-page-capability'],'manage');assert.deepEqual(spec.webhooks.pageUpdateMetadata.post.security,[{WebhookSignature:[]}]);
});

test('documented anonymous form schema and idempotent receipts match actual private SQLite storage',async t=>{
 const f=fixture(t),base='/api/content/workspaces/workspace',read=async response=>{assert.ok(response.ok,await response.clone().text());return response.json();};
 const collection=await read(await f.request(base+'/collections',{method:'POST',body:{expectedRevision:1,title:'Private docs form responses',parentId:null,properties:[{id:'score',name:'Private score column',type:'number',required:true}]}}));
 const forms=base+'/collections/'+collection.collectionId+'/forms',created=await read(await f.request(forms,{method:'POST',body:{expectedRevision:2,definition:{title:'Public question',description:'Synthetic only',fields:[{id:'question',propertyId:'score',label:'Score',description:'Required numeric answer',required:true,condition:null}]}}}));
 await read(await f.request(forms+'/'+created.formId+'/acceptance',{method:'POST',body:{expectedRevision:3,accepting:true,audience:'anonymous',confirmManagerAccess:true,confirmPublicExposure:true}}));
 const managed=await read(await f.request(forms+'/'+created.formId)),token=new URL(managed.form.publicPath,origin).searchParams.get('public'),path='/api/public/forms/'+token,template='/api/public/forms/{token}';
 const definition=await responseMatches(template,'get',await f.request(path,{account:null}));assert.equal(definition.accountRequired,false);assert.equal(definition.fields[0].propertyId,undefined);assert.equal(definition.id,'public-form');
 const input={requestId:crypto.randomUUID(),version:1,answers:{question:0}};requestMatches(template+'/responses','post',input);const first=await responseMatches(template+'/responses','post',await f.request(path+'/responses',{method:'POST',account:null,body:input}),201);assert.deepEqual(first,{requestId:input.requestId,accepted:true});
 await responseMatches(template+'/responses','post',await f.request(path+'/responses',{method:'POST',account:null,body:input}));await responseMatches(template+'/responses','post',await f.request(path+'/responses',{method:'POST',account:null,body:{...input,answers:{question:1}}}),409);
 const raw=await fixtureState(f);assert.equal(raw.payload.publicFormReceipts.length,1);assert.equal(raw.payload.collections[0].collection.records.length,1);assert.equal((await f.request(base+'/pages/'+raw.payload.publicFormReceipts[0].pageId,{account:null})).status,401);
 await responseMatches(template+'/responses','post',await f.request(path+'/responses',{method:'POST',account:null,body:{...input,requestId:crypto.randomUUID(),answers:{question:'0'}}}),400);
 await responseMatches(template+'/responses','post',await f.request(path+'/responses',{method:'POST',account:null,body:input,headers:{Origin:'https://foreign.example.invalid'}}),403);await responseMatches(template,'get',await f.request('/api/public/forms/'+'a'.repeat(160),{account:null}),404);
 assert.equal(validator(schema('PublicFormReceipt')).validate({...first,pageId:'private'}).valid,false);assert.equal(validator(schema('PublicFormDefinition')).validate({...definition,workspaceId:'private'}).valid,false);assert.equal(validator(schema('PublicFormSubmission')).validate({...input,accountId:'owner'}).valid,false);
});

test('documented canonical scopes, event types and bounded DTO limits match exported runtime contracts',()=>{
 assert.deepEqual(schema('TokenScopes').enum,API_TOKEN_SCOPE_SETS);assert.deepEqual(schema('WebhookEventType').enum,WEBHOOK_EVENT_TYPES);
 assert.deepEqual(Object.fromEntries(Object.entries(schema('ApiTokenLimits').properties).map(([key,value])=>[key,value.const])),API_TOKEN_LIMITS);
 assert.equal(schema('ExternalBlock')['x-max-tree-depth'],API_TOKEN_LIMITS.depth);assert.equal(schema('ExternalBlock')['x-max-total-blocks'],API_TOKEN_LIMITS.blocks);assert.equal(spec.paths['/api/v1/pages/{pageId}/document'].patch.requestBody['x-max-utf8-bytes'],API_TOKEN_LIMITS.documentBytes+4096);
 assert.equal(schema('WebhookEvent')['x-max-utf8-bytes'],WEBHOOK_LIMITS.eventBytes);assert.deepEqual(schema('WebhookEvent')['x-canonical-json-property-order'],['schemaVersion','eventId','eventType','workspaceId','pageId','version','occurredAt']);
 assert.deepEqual(Object.fromEntries(Object.entries(schema('RoomLimits').properties).map(([key,value])=>[key,value.const])),ROOM_LIMITS);
 assert.deepEqual(Object.fromEntries(Object.entries(schema('RoomPresenceLimits').properties).map(([key,value])=>[key,value.const])),PRESENCE_LIMITS);
 assert.equal(schema('RoomEncodedUpdate')['x-max-decoded-bytes'],ROOM_LIMITS.updateBytes);assert.equal(schema('RoomEncodedState')['x-max-decoded-bytes'],ROOM_LIMITS.stateBytes);assert.equal(schema('RoomPresenceResponse').properties.ttlMs.const,PRESENCE_LIMITS.ttlMs);
 for(const scopes of API_TOKEN_SCOPE_SETS){matches(schema('TokenScopes'),scopes);assert.deepEqual(validateTokenCreate({requestId:crypto.randomUUID(),expectedRevision:1,workspaceId:'workspace',pageId:'page',name:'Synthetic',scopes,expiresAt:'2026-10-17T00:00:00.000Z',confirmPageAccess:true},'2026-10-16T00:00:00.000Z').scopes,scopes);}
 for(const scopes of [['document:read'],['page:read','document:write'],['page:read','mcp:connect','document:read'],['page:read','mcp:connect','mcp:connect']])assert.equal(validator(schema('TokenScopes')).validate(scopes).valid,false);
});

test('actual SQLite token, external read/write, revocation and MCP metadata responses validate against their documented route schemas',async t=>{
 const f=fixture(t),manage='/api/integrations/tokens',document='/api/v1/pages/{pageId}/document';await responseMatches(manage,'get',await f.request(manage));
 const input=f.intent();requestMatches(manage,'post',input);const issued=await responseMatches(manage,'post',await f.request(manage,{method:'POST',body:input}),201),authorization='Bearer '+issued.token;
 const replay=await responseMatches(manage,'post',await f.request(manage,{method:'POST',body:input}));assert.equal(replay.token,null);
 await responseMatches('/api/v1/pages/{pageId}','get',await f.request('/api/v1/pages/page',{authorization}));const read=await responseMatches(document,'get',await f.request('/api/v1/pages/page/document',{authorization}));assert.equal(read.document.version,1);assert.doesNotMatch(JSON.stringify(read),/private-fixture-metadata|objectKey/);
 const update={expectedVersion:1,title:'Updated title',blocks:[{id:'body',type:'paragraph',data:{text:'Updated plain text'}}]};requestMatches(document,'patch',update);const updated=await responseMatches(document,'patch',await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization,body:update}));assert.equal(updated.document.version,2);
 await responseMatches(document,'patch',await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization,body:update}),409);
 const blockPath='/api/v1/pages/{pageId}/blocks',edits={expectedVersion:2,operations:[{type:'append',blocks:[{type:'paragraph',data:{text:'Added without a manual ID'}}]},{type:'update',blockId:'body',data:{text:'Updated individually'}}]};requestMatches(blockPath,'patch',edits);const edited=await responseMatches(blockPath,'patch',await f.request('/api/v1/pages/page/blocks',{method:'PATCH',authorization,body:edits}));assert.equal(edited.page.version,3);assert.equal(edited.document.blocks[0].data.text,'Updated individually');assert.equal(edited.document.blocks.length,2);
 await responseMatches('/api/integrations/mcp','get',await f.request('/api/integrations/mcp'));await responseMatches(manage,'get',await f.request(manage,{account:null}),401);
 const revoke={expectedVersion:1};requestMatches('/api/integrations/tokens/{tokenId}','delete',revoke);const revoked=await responseMatches('/api/integrations/tokens/{tokenId}','delete',await f.request(manage+'/'+issued.metadata.id,{method:'DELETE',body:revoke}));assert.equal(revoked.metadata.status,'revoked');await responseMatches(document,'get',await f.request('/api/v1/pages/page/document',{authorization}),401);
});

test('bounded write schemas reject unsupported reference injection and source loss is a documented 409 instead of a silent replacement',async t=>{
 const f=fixture(t,{sourceBlock:true}),issued=await f.issue(),authorization='Bearer '+issued.token,path='/api/v1/pages/{pageId}/document';
 for(const input of [{expectedVersion:1,title:'Injected aggregate',expectedRevision:1},{expectedVersion:1,blocks:[{id:'body',type:'paragraph',data:{text:'Injected',links:[]}}]},{expectedVersion:1,blocks:[{id:'database',type:'database',data:{text:'Unsupported'}}]},{expectedVersion:1,blocks:[{id:'head',type:'heading',data:{text:'Missing level'}}]}])assert.equal(validator(schema('DocumentWriteRequest')).validate(input).valid,false);
 const read=await responseMatches(path,'get',await f.request('/api/v1/pages/page/document',{authorization}));assert.equal(read.omittedBlocks,1);
 const replace={expectedVersion:1,blocks:read.document.blocks};requestMatches(path,'patch',replace);const rejected=await responseMatches(path,'patch',await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization,body:replace}),409);assert.equal(rejected.error.code,'EXTERNAL_DOCUMENT_READ_ONLY');
 const rename={expectedVersion:1,title:''};requestMatches(path,'patch',rename);const updated=await responseMatches(path,'patch',await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization,body:rename}));assert.equal(updated.omittedBlocks,1);assert.equal(updated.page.title,'');
});

test('all Webhook administration/subscription/delivery request and response DTOs validate against live SQLite service behavior',async t=>{
 const f=fixture(t),configPath='/api/webhooks/config',approvalPath='/api/webhooks/approval',base='/api/webhooks/workspaces/workspace/pages/page',template='/api/webhooks/workspaces/{workspaceId}/pages/{pageId}',subscription=template+'/subscription',deliveries=template+'/deliveries',config=await responseMatches(configPath,'get',await f.request(configPath));
 assert.equal(config.approval,null);assert.deepEqual(config.eventTypes,WEBHOOK_EVENT_TYPES);const approval={expectedVersion:0,profileDigest:config.profile.profileDigest,eventTypes:config.eventTypes,confirmMetadataTransfer:true};requestMatches(approvalPath,'post',approval);
 const approved=await responseMatches(approvalPath,'post',await f.request(approvalPath,{account:'admin',method:'POST',body:approval}));assert.equal(approved.approval.approved,true);
 const initial=await responseMatches(subscription,'get',await f.request(base+'/subscription'));assert.equal(initial.subscription,null);const subscribe={expectedRevision:initial.revision,expectedVersion:0,profileDigest:config.profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:false};requestMatches(subscription,'post',subscribe);const active=await responseMatches(subscription,'post',await f.request(base+'/subscription',{method:'POST',body:subscribe}));assert.equal(active.subscription.status,'active');
 const issued=await f.issue(),update={expectedVersion:1,title:'Webhook changed title',blocks:[{id:'body',type:'paragraph',data:{text:'Webhook changed body'}}]};await responseMatches('/api/v1/pages/{pageId}/document','patch',await f.request('/api/v1/pages/page/document',{method:'PATCH',authorization:'Bearer '+issued.token,body:update}));
 const blockEdit={expectedVersion:2,operations:[{type:'append',blocks:[{type:'paragraph',data:{text:'Incremental change'}}]}]};await responseMatches('/api/v1/pages/{pageId}/blocks','patch',await f.request('/api/v1/pages/page/blocks',{method:'PATCH',authorization:'Bearer '+issued.token,body:blockEdit}));
 const rows=await responseMatches(deliveries,'get',await f.request(base+'/deliveries'));assert.equal(rows.deliveries.length,5);assert.deepEqual(rows.deliveries.filter(row=>row.pageVersion===3).map(row=>row.eventType).sort(),['page.document.updated','page.updated']);
 const cancel={expectedRevision:rows.revision,expectedVersion:rows.deliveries[0].version};requestMatches(deliveries+'/{eventId}','delete',cancel);const cancelled=await responseMatches(deliveries+'/{eventId}','delete',await f.request(base+'/deliveries/'+rows.deliveries[0].eventId,{method:'DELETE',body:cancel}));assert.ok(cancelled.deliveries.some(row=>row.status==='cancelled'));
 const stop={expectedRevision:rows.revision,expectedVersion:active.subscription.version};requestMatches(subscription,'delete',stop);assert.equal((await responseMatches(subscription,'delete',await f.request(base+'/subscription',{method:'DELETE',body:stop}))).subscription.status,'cancelled');
 const revoke={expectedVersion:approved.approval.version,profileDigest:config.profile.profileDigest};requestMatches(approvalPath,'delete',revoke);assert.equal((await responseMatches(approvalPath,'delete',await f.request(approvalPath,{account:'admin',method:'DELETE',body:revoke}))).approval.approved,false);
 await responseMatches(configPath,'get',await f.request(configPath,{account:null}),401);await responseMatches(configPath,'get',await f.request(configPath,{headers:{Authorization:'Bearer forbidden-cookie-route'}}),403);
});

test('the outbound-only Webhook schema and headers match the actual canonical signer without exposing private document fields',async t=>{
 const f=fixture(t),{config}=await f.ready,event=validateWebhookEvent({schemaVersion:1,eventId:crypto.randomUUID(),eventType:'page.document.updated',workspaceId:'workspace',pageId:'page',version:2,occurredAt:new Date().toISOString()}),signed=await signWebhookEvent(config,event),receiver=spec.webhooks.pageUpdateMetadata.post;
 matches(receiver.requestBody.content['application/json'].schema,JSON.parse(signed.body));assert.deepEqual(Object.keys(JSON.parse(signed.body)),schema('WebhookEvent')['x-canonical-json-property-order']);
 for(const parameter of receiver.parameters){const value=signed.headers[parameter.name];assert.ok(value);matches(parameter.schema,value);}
 assert.equal(signed.headers['X-Yumunio-Signature'],'sha256='+createHmac('sha256',config.signingKey).update(signed.headers['X-Yumunio-Timestamp']+'.'+signed.body).digest('hex'));
 assert.equal(await verifyWebhookSignature(config,{body:signed.body,timestamp:signed.headers['X-Yumunio-Timestamp'],signature:signed.headers['X-Yumunio-Signature'],now:event.occurredAt}),true);
 assert.equal(validator(schema('WebhookEvent')).validate({...event,title:'Private title'}).valid,false);assert.equal(receiver['x-delivery-policy'].attempts,WEBHOOK_LIMITS.attempts);assert.equal(receiver['x-delivery-policy'].timeoutMilliseconds,WEBHOOK_LIMITS.timeoutMs);assert.equal(receiver['x-delivery-policy'].signatureToleranceSeconds,WEBHOOK_LIMITS.signatureToleranceSeconds);assert.deepEqual(receiver['x-delivery-policy'].retryDelaysSeconds,[1,2,3].map(attempt=>webhookRetryDelay(attempt)/1000));
 const projected=projectTokenPage({page:{id:'page',title:'Literal example'},document:{pageId:'page',workspaceId:'workspace',version:1,updatedAt:event.occurredAt,blocks:[{id:'body',type:'paragraph',data:{text:'Literal body',objectKey:'private'}},{id:'source',type:'code',data:{text:'Private source',purpose:'import-source'}}]}},{document:true});matches(schema('ExternalDocumentResponse'),projected);assert.equal(projected.omittedBlocks,1);assert.doesNotMatch(JSON.stringify(projected),/objectKey|Private source/);
});

const roomTemplate='/api/content/workspaces/{workspaceId}/pages/{pageId}/room',roomPath='/api/content/workspaces/workspace/pages/page/room';
async function openDocumentedRoom(f,status=201){
 const{content}=await f.ready,input={expectedRevision:(await content.read('workspace','owner')).revision};requestMatches(roomTemplate+'/open','post',input);
 return responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:input}),status);
}
const presenceInput=(room,clientId=crypto.randomUUID(),cursor=null)=>({epoch:room.epoch,ticket:room.ticket,clientId,sequence:room.sequence,documentVersion:room.documentVersion,cursor});

test('documented protocol-2 room seeds, structural/formatted updates and explicit resets match real SQLite responses',async t=>{
 const f=fixture(t,{sourceBlock:true}),{content}=await f.ready;const input={expectedRevision:(await content.read('workspace','owner')).revision,protocol:2};requestMatches(roomTemplate+'/open','post',input);
 const opened=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:input}),201);assert.equal(opened.protocol,2);assert.equal(opened.seed.blocks[0].data.objectKey,'private-fixture-metadata');
 const headers={'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Ticket':opened.ticket};await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Ticket':opened.ticket}}),409);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers}));const doc=loadStructuredRoom(fromBase64(opened.update),opened.seed),vector=Y.encodeStateVector(doc);let update;
 try{structuredRoomOperation(doc,opened.seed,{kind:'add',blockId:'schema-block',type:'paragraph',parentId:null,beforeId:null});structuredRoomText(doc,'block:schema-block','New text');structuredRoomFormat(doc,opened.seed,{blockId:'schema-block',start:0,end:8,marks:[{start:0,end:8,styles:['bold']}]});update={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(doc,vector))};}finally{doc.destroy();}
 requestMatches(roomTemplate+'/updates','post',update);const ack=await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',headers:{'X-Yumunio-Room-Protocol':'2'},body:update}));assert.equal(ack.protocol,2);assert.equal(ack.acknowledged,true);
 const saved=await content.read('workspace','owner');assert.equal(saved.payload.pages[0].document.blocks.at(-1).data.marks[0].styles[0],'bold');const reset={expectedRevision:saved.revision,protocol:2,reset:true};requestMatches(roomTemplate+'/open','post',reset);const fresh=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:reset}),201);assert.notEqual(fresh.epoch,opened.epoch);
 for(const body of [{expectedRevision:1,reset:true},{expectedRevision:1,protocol:1},{expectedRevision:1,protocol:2,reset:false}])assert.equal(validator(schema('RoomOpenRequest')).validate(body).valid,false);
});

test('all five documented room routes validate actual SQLite state, durable text updates, renewal and private ephemeral presence DTOs',async t=>{
 const f=fixture(t,{sourceBlock:true}),{content}=await f.ready;
 await responseMatches(roomTemplate,'get',await f.request(roomPath),409);
 const opened=await openDocumentedRoom(f);assert.equal(opened.editable,true);assert.equal(opened.documentVersion,1);
 const repeated=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:0}}));assert.equal(repeated.epoch,opened.epoch);assert.equal(repeated.revision,opened.revision);
 const headers={'X-Yumunio-Room-Ticket':opened.ticket,'X-Yumunio-State-Vector':opened.stateVector};
 const state=await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers}));assert.equal(state.sequence,opened.sequence);
 const before=await content.read('workspace','owner'),item=before.payload.pages[0],doc=loadRoomDocument(fromBase64(opened.update),{title:item.page.title,blocks:item.document.blocks});
 let update;
 try{assert.deepEqual([...doc.share.keys()].sort(),['block:body','title']);const vector=Y.encodeStateVector(doc);doc.getText('block:body').insert(0,'Coedited ');update={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(doc,vector))};}finally{doc.destroy();}
 requestMatches(roomTemplate+'/updates','post',update);const ack=await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body:update}));assert.equal(ack.acknowledged,true);assert.equal(ack.documentVersion,2);
 const replay=await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body:update}));assert.equal(replay.revision,ack.revision);assert.equal(replay.sequence,ack.sequence);
 const saved=await content.read('workspace','owner');assert.equal(saved.payload.pages[0].document.blocks[0].data.text,'Coedited Original body');assert.equal(saved.payload.pages[0].document.blocks[1].data.text,'Private source archive');
 const cursor={blockId:'body',start:0,end:8,direction:'forward'},input=presenceInput({...ack,ticket:opened.ticket},crypto.randomUUID(),cursor);requestMatches(roomTemplate+'/presence','post',input);
 const roster=await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:input}));assert.equal(roster.participants.length,1);assert.deepEqual(roster.participants[0].cursor,cursor);assert.equal(roster.participants[0].self,true);
 assert.doesNotMatch(JSON.stringify(roster),/accountId|membershipId|sessionId|session-owner|synthetic-session|@example|ticket|Original body|objectKey/);
 await responseMatches(roomTemplate+'/presence','get',await f.request(roomPath+'/presence',{headers:{'X-Yumunio-Room-Ticket':opened.ticket,'X-Yumunio-Presence-Client':input.clientId}}));
 const renew={epoch:opened.epoch,ticket:opened.ticket};requestMatches(roomTemplate+'/renew','post',renew);const renewed=await responseMatches(roomTemplate+'/renew','post',await f.request(roomPath+'/renew',{method:'POST',body:renew}));assert.equal(renewed.documentVersion,2);assert.equal(renewed.editable,true);
 const leave={epoch:opened.epoch,ticket:renewed.ticket,clientId:input.clientId};requestMatches(roomTemplate+'/presence','delete',leave);await responseMatches(roomTemplate+'/presence','delete',await f.request(roomPath+'/presence',{method:'DELETE',body:leave}));
 const empty=await responseMatches(roomTemplate+'/presence','get',await f.request(roomPath+'/presence',{headers:{'X-Yumunio-Room-Ticket':renewed.ticket,'X-Yumunio-Presence-Client':input.clientId}}));assert.deepEqual(empty.participants,[]);assert.deepEqual(await content.read('workspace','owner'),saved);
 const readOnly=structuredClone(saved.payload);readOnly.grants[0].permission='viewer';f.db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(readOnly),'workspace');
 const viewer=await openDocumentedRoom(f,200);assert.equal(viewer.editable,false);const viewerState=await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Ticket':viewer.ticket}}));assert.equal(viewerState.editable,false);
 await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body:{...update,ticket:viewer.ticket}}),404);
 const viewerPresence=await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:presenceInput(viewer)}));assert.equal(viewerPresence.participants.length,1);
});

test('documented room cookie/account/Origin/ticket and binary grammar failures match live handler status schemas',async t=>{
 const f=fixture(t,{sourceBlock:true}),opened=await openDocumentedRoom(f),ticketHeaders={'X-Yumunio-Room-Ticket':opened.ticket};
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{account:null,authorization:'Bearer synthetic-not-a-cookie'}),401);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...ticketHeaders,'X-Yumunio-Expected-Account':'admin'}}),404);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...ticketHeaders,'X-Yumunio-Expected-Account':''}}),400);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...ticketHeaders,Origin:'https://foreign.example.invalid'}}),403);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...ticketHeaders,'Sec-Fetch-Site':'cross-site'}}),403);
 await responseMatches(roomTemplate,'get',await f.request(roomPath),404);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Ticket':'forged.ticket'}}),404);
 await responseMatches(roomTemplate,'get',await f.request(roomPath+'?unexpected=true',{headers:ticketHeaders}),400);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...ticketHeaders,'X-Yumunio-State-Vector':'AAAA'}}),400);
 await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:1},headers:{Origin:''}}),403);
 await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:1},headers:{'Content-Type':'text/plain'}}),415);
 const extra={expectedRevision:1,displayName:'Spoofed'};assert.equal(validator(schema('RoomOpenRequest')).validate(extra).valid,false);await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:extra}),400);
 const badUpdate={epoch:opened.epoch,ticket:opened.ticket,update:'AAAA'};requestMatches(roomTemplate+'/updates','post',badUpdate);await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body:badUpdate}),400);
 const injected=presenceInput(opened);injected.displayName='Client-supplied name';assert.equal(validator(schema('RoomPresencePublishRequest')).validate(injected).valid,false);await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:injected}),400);
 const invalidCursor=presenceInput(opened,crypto.randomUUID(),{blockId:'source',start:0,end:0,direction:'none'});requestMatches(roomTemplate+'/presence','post',invalidCursor);await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:invalidCursor}),400);
 const stale=presenceInput({...opened,sequence:opened.sequence+1},crypto.randomUUID(),{blockId:'body',start:0,end:1,direction:'forward'});const hidden=await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:stale}));assert.equal(hidden.participants[0].cursor,null);
 f.setTime(new Date(Date.parse(opened.expiresAt)+60000).toISOString());await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:ticketHeaders}),404);
 await responseMatches(roomTemplate+'/renew','post',await f.request(roomPath+'/renew',{method:'POST',body:{epoch:opened.epoch,ticket:opened.ticket}}));
 f.setTime(new Date(Date.parse(opened.expiresAt)+5*60000).toISOString());await responseMatches(roomTemplate+'/renew','post',await f.request(roomPath+'/renew',{method:'POST',body:{epoch:opened.epoch,ticket:opened.ticket}}),404);
});

test('documented presence quota, schema-unavailable and changed-epoch responses preserve ordinary durable room content',async t=>{
 const f=fixture(t),opened=await openDocumentedRoom(f),{content}=await f.ready,before=await content.read('workspace','owner');
 for(let count=0;count<PRESENCE_LIMITS.clientsPerAccount;count++)await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:presenceInput(opened)}));
 await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:presenceInput(opened)}),429);assert.deepEqual(await content.read('workspace','owner'),before);
 f.db.exec('DROP TABLE yumunio_room_presence');await responseMatches(roomTemplate+'/presence','post',await f.request(roomPath+'/presence',{method:'POST',body:presenceInput(opened)}),503);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Ticket':opened.ticket}}));
 const changed=structuredClone(before.payload);changed.rooms=[];f.db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(changed),'workspace');
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Ticket':opened.ticket}}),409);
 const disabled=fixture(t,{roomEnabled:false});await responseMatches(roomTemplate+'/open','post',await disabled.request(roomPath+'/open',{method:'POST',body:{expectedRevision:1}}),503);
});


const accountBase='/api/content/workspaces/workspace',accountTemplate='/api/content/workspaces/{workspaceId}';
const commentsPath=accountBase+'/pages/page/comments',commentsTemplate=accountTemplate+'/pages/{pageId}/comments',threadTemplate=commentsTemplate+'/{threadId}',messageTemplate=threadTemplate+'/messages/{messageId}',inboxTemplate=accountTemplate+'/notifications';
async function fixtureState(f){return(await f.ready).content.read('workspace','owner');}
async function changeFixtureContent(f,change){
 const saved=await fixtureState(f);change(saved.payload);validateContentPayload(saved.payload,'workspace');
 f.db.prepare('UPDATE yumunio_account_content SET revision=revision+1,payload_json=? WHERE workspace_id=?').run(JSON.stringify(saved.payload),'workspace');
 return fixtureState(f);
}
async function addFixturePeople(f,permissions){
 const saved=await fixtureState(f),stamp=saved.payload.pages[0].page.createdAt;
 for(const[id]of permissions){
  f.db.prepare('INSERT INTO yumunio_users(id,name,email,emailVerified,createdAt,updatedAt)VALUES(?,?,?,1,?,?)').run(id,'Synthetic '+id,id+'@example.invalid',stamp,stamp);
  f.db.prepare('INSERT INTO yumunio_memberships(id,organizationId,userId,role,createdAt)VALUES(?,?,?,?,?)').run('membership-'+id,'workspace',id,'guest',stamp);
 }
 return changeFixtureContent(f,payload=>{for(const[id,permission]of permissions)if(permission){const grantId='grant-'+id;payload.grants.push({id:grantId,workspaceId:'workspace',pageId:'page',accountId:id,permission,includeDescendants:false,status:'active'});payload.grantBindings.push({grantId,membershipId:'membership-'+id});}});
}
async function commentMutation(f,route,template,fields,{method='POST',account='owner',status=200}={}){
 const body={expectedRevision:(await fixtureState(f)).revision,...fields};requestMatches(template,method.toLowerCase(),body);
 return responseMatches(template,method.toLowerCase(),await f.request(route,{method,account,body}),status);
}

test('atomic block-move schemas accept legacy and normalized forest DTOs while stale, hidden and source moves leave both documents intact',async t=>{
 const f=fixture(t,{sourceBlock:true}),template=accountTemplate+'/pages/{pageId}/blocks/move',path=accountBase+'/pages/page/blocks/move';
 await changeFixtureContent(f,payload=>{
  const source=payload.pages[0],stamp=source.page.createdAt;
  source.document.blocks.splice(1,0,{id:'layout',type:'columns',children:[{id:'left-column',type:'column',children:[{id:'left-body',type:'paragraph',data:{text:'Left'}}]},{id:'right-column',type:'column',children:[{id:'right-body',type:'paragraph',data:{text:'Right'}}]}]});
  payload.pages.push({page:{...source.page,id:'target',title:'Destination'},document:{...source.document,pageId:'target',blocks:[{id:'destination-body',type:'paragraph',data:{text:'Destination'}}]},inheritPermissions:false});
  payload.grants.push({...payload.grants[0],id:'target-grant',pageId:'target'});payload.grantBindings.push({grantId:'target-grant',membershipId:'membership'});
 });
 const before=await fixtureState(f),common={expectedRevision:before.revision,expectedVersion:1,targetPageId:'target',targetExpectedVersion:1,parentBlockId:null,index:1};
 for(const input of [{...common},{...common,blockId:'body',blockIds:['body']}]){assert.equal(validator(schema('BlockMoveRequest')).validate(input).valid,false);await responseMatches(template,'post',await f.request(path,{method:'POST',body:input}),400);}
 await responseMatches(template,'post',await f.request(path,{method:'POST',body:{...common,blockId:'source'}}),409);
 await responseMatches(template,'post',await f.request(path,{method:'POST',body:{...common,blockIds:['body'],targetExpectedVersion:0}}),409);
 await responseMatches(template,'post',await f.request(path,{method:'POST',body:{...common,blockIds:['body'],targetPageId:'hidden'}}),404);
 assert.deepEqual(await fixtureState(f),before);
 const input={...common,blockIds:['left-body','layout','body','body']};requestMatches(template,'post',input);
 const moved=await responseMatches(template,'post',await f.request(path,{method:'POST',body:input}));assert.deepEqual(moved.blockIds,['body','layout']);assert.equal(moved.sourceVersion,2);assert.equal(moved.targetVersion,2);assert.equal(Object.hasOwn(moved,'blockId'),false);
 const saved=await fixtureState(f);assert.deepEqual(saved.payload.pages[0].document.blocks,[before.payload.pages[0].document.blocks[2]]);assert.deepEqual(saved.payload.pages[1].document.blocks.slice(1),before.payload.pages[0].document.blocks.slice(0,2));assert.doesNotMatch(JSON.stringify(moved),/private-fixture-metadata|Left|membership/);
 const legacy={expectedRevision:saved.revision,expectedVersion:2,targetPageId:'target',targetExpectedVersion:2,parentBlockId:null,index:0,blockId:'body'};requestMatches(template,'post',legacy);
 const one=await responseMatches(template,'post',await f.request(accountBase+'/pages/target/blocks/move',{method:'POST',body:legacy}));assert.equal(one.blockId,'body');assert.equal(one.sourceVersion,3);assert.equal(one.targetVersion,3);assert.equal(Object.hasOwn(one,'blockIds'),false);
});

test('comment, thread, message, resolve, people and inbox route schemas validate real SQLite discussion and mention/reply lifecycle DTOs',async t=>{
 const f=fixture(t);await addFixturePeople(f,[['commenter','commenter'],['viewer','viewer'],['hidden',null]]);
 const people=await responseMatches(accountTemplate+'/pages/{pageId}/people','get',await f.request(accountBase+'/pages/page/people'));assert.deepEqual(people.people.map(person=>person.accountId).sort(),['commenter','owner','viewer']);assert.doesNotMatch(JSON.stringify(people),/email|membership|example.invalid/);
 const started=await commentMutation(f,commentsPath,commentsTemplate,{blockId:'body',text:'Hello @Viewer',mentions:[{accountId:'viewer',start:6,end:13}]}),threadId=started.thread.id,route=commentsPath+'/'+threadId,originalId=started.thread.messages[0].id;
 const list=await responseMatches(commentsTemplate,'get',await f.request(commentsPath,{account:'viewer'}));assert.equal(list.canComment,false);assert.equal(list.threads.length,1);
 const one=await responseMatches(threadTemplate,'get',await f.request(route));assert.equal(one.threads[0].id,threadId);
 await changeFixtureContent(f,payload=>{delete payload.discussion.notifications[0].reason;});
 const initial=await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications',{account:'viewer'}));assert.equal(initial.notifications[0].reason,'mention');
 await commentMutation(f,accountBase+'/notifications',inboxTemplate,{notificationIds:[initial.notifications[0].id]},{account:'viewer'});
 const reply=await commentMutation(f,route,threadTemplate,{text:'Reply @Owner',mentions:[{accountId:'owner',start:6,end:12}]},{account:'commenter'}),replyId=reply.thread.messages[1].id;
 const inbox=await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications'));assert.equal(inbox.notifications.length,1);assert.equal(inbox.notifications[0].reason,'reply');
 await commentMutation(f,accountBase+'/notifications',inboxTemplate,{notificationIds:[inbox.notifications[0].id]});
 const marked=await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications'));assert.ok(marked.notifications[0].readAt);
 await commentMutation(f,route+'/messages/'+replyId,messageTemplate,{text:'Edited reply without mention',mentions:[]},{method:'PATCH',account:'commenter'});
 const afterEdit=await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications'));assert.equal(afterEdit.notifications[0].id,inbox.notifications[0].id);assert.equal(afterEdit.notifications[0].readAt,marked.notifications[0].readAt);
 await commentMutation(f,route+'/messages/'+replyId,messageTemplate,{text:'Manager cannot rewrite another author',mentions:[]},{method:'PATCH',status:404});
 await commentMutation(f,route+'/resolve',threadTemplate+'/resolve',{resolved:true},{method:'PATCH'});
 const blocked=await commentMutation(f,route,threadTemplate,{text:'Closed thread reply',mentions:[]},{account:'commenter',status:409});assert.equal(blocked.error.code,'COMMENT_THREAD_RESOLVED');
 await commentMutation(f,route+'/resolve',threadTemplate+'/resolve',{resolved:false},{method:'PATCH'});
 await commentMutation(f,route+'/messages/'+originalId,messageTemplate,{text:'Edited original without mention',mentions:[]},{method:'PATCH'});
 assert.deepEqual((await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications',{account:'viewer'}))).notifications,[]);
 const deleted=await commentMutation(f,route+'/messages/'+replyId,messageTemplate,{}, {method:'DELETE'});assert.equal(deleted.thread.messages[1].text,'');assert.ok(deleted.thread.messages[1].deletedAt);
 assert.deepEqual((await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications'))).notifications,[]);
 const saved=await fixtureState(f);assert.equal(saved.payload.pages[0].document.version,1);assert.doesNotMatch(JSON.stringify(deleted),/membershipId|authorMembershipId|recipientId|example.invalid/);
});

test('discussion schemas and actual handlers reject identity/range/source injection and enforce cookie, current access and visible-inbox boundaries',async t=>{
 const f=fixture(t,{sourceBlock:true});await addFixturePeople(f,[['commenter','commenter'],['viewer','viewer'],['hidden',null]]);
 await responseMatches(commentsTemplate,'get',await f.request(commentsPath,{account:null,authorization:'Bearer synthetic-not-session'}),401);
 for(const[headers,status]of [[{'X-Yumunio-Expected-Account':''},400],[{'X-Yumunio-Expected-Account':'admin'},404],[{Origin:'https://foreign.example.invalid'},403]])await responseMatches(commentsTemplate,'get',await f.request(commentsPath,{headers}),status);
 await responseMatches(commentsTemplate,'get',await f.request(commentsPath+'?unexpected=true'),400);await responseMatches(commentsTemplate,'get',await f.request(commentsPath,{account:'hidden'}),404);
 const before=await fixtureState(f),input={expectedRevision:before.revision,blockId:'body',text:'Hello @Viewer',mentions:[{accountId:'viewer',start:6,end:13}]};
 for(const[body,status]of [[{...input,blockId:'source'},404],[{...input,mentions:[{accountId:'hidden',start:6,end:13}]},404],[{...input,mentions:[{accountId:'viewer',start:0,end:5}]},400],[{...input,expectedRevision:0},409]])await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body}),status);
 for(const body of [{...input,reason:'reply'},{...input,mentions:[{...input.mentions[0],membershipId:'forged'}]}]){assert.equal(validator(schema('CommentCreateRequest')).validate(body).valid,false);await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body}),400);}
 await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body:input,account:'viewer'}),404);
 await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body:input,headers:{Origin:''}}),403);
 await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body:input,headers:{'Content-Type':'text/plain'}}),415);
 assert.deepEqual(await fixtureState(f),before);
 await responseMatches(commentsTemplate,'post',await f.request(commentsPath,{method:'POST',body:input}));
 const viewerInbox=await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications',{account:'viewer'})),notificationId=viewerInbox.notifications[0].id;
 await commentMutation(f,accountBase+'/notifications',inboxTemplate,{notificationIds:[notificationId]},{status:404});
 await changeFixtureContent(f,payload=>{payload.grants.find(grant=>grant.accountId==='viewer').status='revoked';});
 assert.deepEqual((await responseMatches(inboxTemplate,'get',await f.request(accountBase+'/notifications',{account:'viewer'}))).notifications,[]);
 await commentMutation(f,accountBase+'/notifications',inboxTemplate,{notificationIds:[notificationId]},{account:'viewer',status:404});
 assert.equal(validator(schema('InboxReadRequest')).validate({expectedRevision:1,notificationIds:[notificationId,notificationId]}).valid,false);
});

const teamspacesTemplate=accountTemplate+'/teamspaces',teamspaceTemplate=teamspacesTemplate+'/{teamspaceId}',placementReviewTemplate=accountTemplate+'/pages/{pageId}/teamspace-review',placementTemplate=accountTemplate+'/pages/{pageId}/teamspace';
async function documentedTeamspaceMutation(f,path,template,fields,{method='POST',account='owner',status=200}={}){
 const input={expectedRevision:(await fixtureState(f)).revision,...fields};requestMatches(template,method.toLowerCase(),input);
 return responseMatches(template,method.toLowerCase(),await f.request(path,{method,account,body:input}),status);
}
async function documentedTeamspaceCreate(f,fields={},options={}){
 return documentedTeamspaceMutation(f,accountBase+'/teamspaces',teamspacesTemplate,{name:'Synthetic teamspace',description:'Local API contract fixture',visibility:'open',defaultPermission:'editor',...fields},options);
}
async function prepareTeamspacePeople(f){
 await addFixturePeople(f,[['participant',null],['outside',null],['guest',null]]);
 f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('member','participant');
 f.db.prepare('UPDATE yumunio_memberships SET role=? WHERE userId=?').run('owner','outside');
}

test('teamspace schemas preserve exact role enums, current bounded limits and reject client ownership or membership injection',()=>{
 assert.deepEqual(schema('TeamspaceProjection').properties.visibility.enum,TEAMSPACE_VISIBILITIES);
 assert.deepEqual(schema('TeamspaceProjection').properties.defaultPermission.enum,TEAMSPACE_PERMISSIONS);
 assert.deepEqual(schema('TeamspaceMember').properties.role.enum,TEAMSPACE_ROLES);
 assert.equal(Object.hasOwn(schema('TeamspaceListResponse').properties.teamspaces,'maxItems'),false);
 assert.equal(schema('TeamspaceDetailResponse').properties.members.maxItems,TEAMSPACE_LIMITS.members);
 assert.equal(schema('TeamspaceProjection').properties.memberCount.maximum,TEAMSPACE_LIMITS.members);
 assert.equal(Object.hasOwn(schema('PageTeamspaceReviewResponse').properties.affectedPageCount,'maximum'),false);
 const create={expectedRevision:1,name:'Synthetic',description:'',visibility:'private',defaultPermission:'viewer'};
 matches(schema('TeamspaceCreateRequest'),create);
 for(const value of [{...create,ownerId:'other'},{...create,id:'chosen'},{...create,icon:'note'},{...create,name:' '},{...create,name:' leading'},{...create,name:'trailing '},{...create,name:'line\nbreak'},{...create,name:'a'.repeat(101)},{...create,description:'x'.repeat(1001)},{...create,visibility:'public'},{...create,defaultPermission:'full'},{...create,expectedRevision:Number.MAX_SAFE_INTEGER}])assert.equal(validator(schema('TeamspaceCreateRequest')).validate(value).valid,false);
 for(const value of [{expectedRevision:1,accountId:'person',role:'admin'},{expectedRevision:1,accountId:'person',role:'owner',membershipId:'injected'}])assert.equal(validator(schema('TeamspaceMemberRequest')).validate(value).valid,false);
 const assignment={expectedRevision:1,expectedVersion:1,teamspaceId:null,reviewDigest:'a'.repeat(64),confirmAccessChange:true};
 matches(schema('PageTeamspaceAssignRequest'),assignment);
 for(const value of [{...assignment,parentId:'nested'},{...assignment,index:0},{...assignment,confirmAccessChange:false},{...assignment,reviewDigest:'not-a-digest'}])assert.equal(validator(schema('PageTeamspaceAssignRequest')).validate(value).valid,false);
});

test('all ten teamspace operations validate actual SQLite list/create/metadata/members/join/archive and reviewed page assignment DTOs',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);
 const empty=await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces'));assert.deepEqual(empty.teamspaces,[]);assert.equal(empty.canCreate,true);
 const memberList=await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces',{account:'participant'}));assert.equal(memberList.canCreate,true);
 const memberCreated=await documentedTeamspaceCreate(f,{name:'Member-created closed team',visibility:'closed'},{account:'participant'});assert.equal(memberCreated.teamspace.role,'owner');
 const created=await documentedTeamspaceCreate(f),teamId=created.teamspace.id,path=accountBase+'/teamspaces/'+teamId;assert.equal(created.teamspace.role,'owner');assert.equal(created.members.length,1);assert.equal(created.members[0].currentUser,true);assert.ok(created.candidates.length>=3);
 const discovered=await responseMatches(teamspaceTemplate,'get',await f.request(path,{account:'participant'}));assert.equal(discovered.teamspace.role,null);assert.ok(discovered.teamspace.capabilities.includes('join'));assert.deepEqual(discovered.members,[]);assert.deepEqual(discovered.candidates,[]);
 const joined=await documentedTeamspaceMutation(f,path+'/join',teamspaceTemplate+'/join',{}, {account:'participant'});assert.equal(joined.teamspace.role,'member');assert.deepEqual(joined.candidates,[]);
 const promoted=await documentedTeamspaceMutation(f,path+'/members',teamspaceTemplate+'/members',{accountId:'participant',role:'owner'});assert.equal(promoted.members.find(row=>row.accountId==='participant').role,'owner');
 const changed=await documentedTeamspaceMutation(f,path,teamspaceTemplate,{name:'Private team',description:'Guarded metadata update',visibility:'private',defaultPermission:'commenter',confirmAccessChange:true},{method:'PATCH'});assert.equal(changed.teamspace.visibility,'private');
 const guestList=await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces',{account:'guest'}));assert.equal(guestList.canCreate,false);assert.deepEqual(guestList.teamspaces,[]);
 const beforeReview=await fixtureState(f),input={expectedRevision:beforeReview.revision,expectedVersion:1,teamspaceId:teamId};requestMatches(placementReviewTemplate,'post',input);
 const reviewed=await responseMatches(placementReviewTemplate,'post',await f.request(accountBase+'/pages/page/teamspace-review',{method:'POST',body:input}));assert.deepEqual(await fixtureState(f),beforeReview);assert.equal(reviewed.beforeReaders,1);assert.equal(reviewed.afterReaders,2);assert.equal(reviewed.addedReaders,1);assert.equal(reviewed.teamspaceOwnersHaveFullAccess,true);assert.equal(reviewed.actorCanReadAfter,true);assert.equal(reviewed.actorCanManageAfter,true);
 const assignment={expectedRevision:reviewed.revision,expectedVersion:reviewed.pageVersion,teamspaceId:reviewed.teamspaceId,reviewDigest:reviewed.reviewDigest,confirmAccessChange:true};requestMatches(placementTemplate,'patch',assignment);
 const assigned=await responseMatches(placementTemplate,'patch',await f.request(accountBase+'/pages/page/teamspace',{method:'PATCH',body:assignment}));assert.equal(assigned.revision,beforeReview.revision+1);assert.equal((await fixtureState(f)).payload.pages[0].document.version,2);
 await documentedTeamspaceMutation(f,path+'/archive',teamspaceTemplate+'/archive',{archived:true});const page=await f.request(accountBase+'/pages/page',{account:'participant'});assert.equal(page.status,200);assert.deepEqual((await page.json()).page.capabilities,['read']);
 const detail=await responseMatches(teamspaceTemplate,'get',await f.request(path)),memberId=detail.members.find(row=>row.accountId==='participant').id;
 const left=await documentedTeamspaceMutation(f,path+'/members',teamspaceTemplate+'/members',{memberId},{method:'DELETE',account:'participant'});assert.equal(left.teamspace.role,null);assert.deepEqual(left.teamspace.capabilities,[]);assert.equal(left.teamspace.memberCount,0);assert.deepEqual(left.members,[]);assert.deepEqual(left.candidates,[]);
 await responseMatches(teamspaceTemplate,'get',await f.request(path,{account:'participant'}),404);
 const restored=await documentedTeamspaceMutation(f,path+'/archive',teamspaceTemplate+'/archive',{archived:false});assert.equal(restored.teamspace.archivedAt,null);
 const current=await fixtureState(f),personalReviewBody={expectedRevision:current.revision,expectedVersion:2,teamspaceId:null};requestMatches(placementReviewTemplate,'post',personalReviewBody);
 const personal=await responseMatches(placementReviewTemplate,'post',await f.request(accountBase+'/pages/page/teamspace-review',{method:'POST',body:personalReviewBody}));assert.equal(personal.teamspaceId,null);assert.equal(personal.teamspaceOwnersHaveFullAccess,false);assert.equal(personal.actorCanReadAfter,true);assert.equal(personal.actorCanManageAfter,true);
 const personalSave={expectedRevision:personal.revision,expectedVersion:personal.pageVersion,teamspaceId:null,reviewDigest:personal.reviewDigest,confirmAccessChange:true};requestMatches(placementTemplate,'patch',personalSave);
 await responseMatches(placementTemplate,'patch',await f.request(accountBase+'/pages/page/teamspace',{method:'PATCH',body:personalSave}));const saved=await fixtureState(f);assert.equal(saved.payload.pages[0].page.parentId,null);assert.equal(saved.payload.pages[0].inheritPermissions,false);assert.equal(saved.payload.personalPageOwners[0].accountId,'owner');
 assert.doesNotMatch(JSON.stringify([created,discovered,joined,promoted,changed,reviewed,assigned,left,restored,personal]),/membershipId|grantBindings|synthetic-session|Private source archive|objectKey|@example.invalid/);
});

test('documented teamspace auth, privacy, archive and digest conflicts reject atomically without workspace-owner bypass',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);const created=await documentedTeamspaceCreate(f,{visibility:'private'}),path=accountBase+'/teamspaces/'+created.teamspace.id;
 await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces',{account:null,authorization:'Bearer synthetic-not-session'}),401);
 for(const[headers,status]of [[{'X-Yumunio-Expected-Account':''},400],[{'X-Yumunio-Expected-Account':'outside'},404],[{Origin:'https://foreign.example.invalid'},403],[{'Sec-Fetch-Site':'cross-site'},403]])await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces',{headers}),status);
 await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces?unexpected=true'),400);await responseMatches(teamspaceTemplate,'get',await f.request(path,{account:'outside'}),404);
 const hidden=await responseMatches(teamspacesTemplate,'get',await f.request(accountBase+'/teamspaces',{account:'outside'}));assert.equal(hidden.teamspaces.some(row=>row.id===created.teamspace.id),false);
 const before=await fixtureState(f),badCreate={expectedRevision:before.revision,name:'Extra fields',description:'',visibility:'open',defaultPermission:'viewer',ownerId:'outside'};
 assert.equal(validator(schema('TeamspaceCreateRequest')).validate(badCreate).valid,false);await responseMatches(teamspacesTemplate,'post',await f.request(accountBase+'/teamspaces',{method:'POST',body:badCreate}),400);
 await documentedTeamspaceMutation(f,path+'/join',teamspaceTemplate+'/join',{}, {account:'participant',status:404});
 await responseMatches(teamspaceTemplate+'/members','post',await f.request(path+'/members',{method:'POST',body:{expectedRevision:before.revision,accountId:'participant',role:'owner'},headers:{Origin:''}}),403);
 await responseMatches(teamspaceTemplate+'/members','post',await f.request(path+'/members',{method:'POST',body:{expectedRevision:before.revision,accountId:'participant',role:'owner'},headers:{'Content-Type':'text/plain'}}),415);
 await documentedTeamspaceMutation(f,path+'/members',teamspaceTemplate+'/members',{memberId:created.members[0].id},{method:'DELETE',status:409});assert.deepEqual(await fixtureState(f),before);
 const reviewInput={expectedRevision:before.revision,expectedVersion:1,teamspaceId:created.teamspace.id},review=await responseMatches(placementReviewTemplate,'post',await f.request(accountBase+'/pages/page/teamspace-review',{method:'POST',body:reviewInput}));
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-participant','participant');
 const unchanged=await fixtureState(f),stale={expectedRevision:review.revision,expectedVersion:review.pageVersion,teamspaceId:review.teamspaceId,reviewDigest:review.reviewDigest,confirmAccessChange:true};requestMatches(placementTemplate,'patch',stale);
 const conflict=await responseMatches(placementTemplate,'patch',await f.request(accountBase+'/pages/page/teamspace',{method:'PATCH',body:stale}),409);assert.equal(conflict.error.code,'TEAMSPACE_REVIEW_CHANGED');assert.deepEqual(await fixtureState(f),unchanged);
 await documentedTeamspaceMutation(f,path+'/archive',teamspaceTemplate+'/archive',{archived:true});const archivedBefore=await fixtureState(f);
 const archived=await documentedTeamspaceMutation(f,path,teamspaceTemplate,{name:'Cannot update',description:'',visibility:'open',defaultPermission:'editor',confirmAccessChange:true},{method:'PATCH',status:409});assert.equal(archived.error.code,'TEAMSPACE_ARCHIVED');
 await documentedTeamspaceMutation(f,path+'/members',teamspaceTemplate+'/members',{accountId:'participant',role:'member'},{status:409});assert.deepEqual(await fixtureState(f),archivedBefore);
});

test('inbox recipient capacity is a documented atomic 413 and replacement membership generations receive no stale automatic replies',async t=>{
 const f=fixture(t);await addFixturePeople(f,[['commenter','commenter']]);
 const created=await commentMutation(f,commentsPath,commentsTemplate,{blockId:null,text:'Original author',mentions:[]},{account:'commenter'}),route=commentsPath+'/'+created.thread.id;
 f.db.prepare('UPDATE yumunio_memberships SET id=? WHERE userId=?').run('replacement-commenter','commenter');
 await commentMutation(f,route,threadTemplate,{text:'No notification to an old generation',mentions:[]});assert.deepEqual((await fixtureState(f)).payload.discussion.notifications,[]);
 const capped=fixture(t),participants=Array.from({length:17},(_,index)=>['prior-'+index,'viewer']);await addFixturePeople(capped,participants);
 const first=await commentMutation(capped,commentsPath,commentsTemplate,{blockId:null,text:'Seed thread',mentions:[]});
 await changeFixtureContent(capped,payload=>{const thread=payload.discussion.threads[0],stamp=thread.createdAt;for(const[id]of participants)thread.messages.push({id:'message-'+id,authorId:id,authorMembershipId:'membership-'+id,text:'Earlier participation',mentions:[],createdAt:stamp,updatedAt:stamp,deletedAt:null});});
 const before=await fixtureState(capped),rejected=await commentMutation(capped,commentsPath+'/'+first.thread.id,threadTemplate,{text:'Cannot notify more than sixteen current recipients',mentions:[]},{status:413});assert.equal(rejected.error.code,'COMMENTS_TOO_LARGE');assert.deepEqual(await fixtureState(capped),before);
});

test('documented teamspace duplication copies settings only, creates one current owner and rejects hidden or unconfirmed writes',async t=>{
 const f=fixture(t);await prepareTeamspacePeople(f);const created=await documentedTeamspaceCreate(f,{visibility:'private',defaultPermission:'commenter',description:'Copy this access policy'}),path=accountBase+'/teamspaces/'+created.teamspace.id,template=teamspaceTemplate+'/duplicate';
 const request={expectedRevision:created.revision,name:'Policy copy',confirmSettingsOnly:true};requestMatches(template,'post',request);
 for(const change of [{confirmSettingsOnly:false},{members:[]},{pageIds:['page']},{ownerId:'outside'},{visibility:'open'},{name:' '}])assert.equal(validator(schema('TeamspaceDuplicateRequest')).validate({...request,...change}).valid,false);
 const before=await fixtureState(f);
 await responseMatches(template,'post',await f.request(path+'/duplicate',{method:'POST',account:'outside',body:request}),404);
 await responseMatches(template,'post',await f.request(path+'/duplicate',{method:'POST',body:{...request,confirmSettingsOnly:false}}),400);
 await responseMatches(template,'post',await f.request(path+'/duplicate',{method:'POST',body:{...request,members:[]}}),400);
 assert.deepEqual(await fixtureState(f),before);
 const copied=await responseMatches(template,'post',await f.request(path+'/duplicate',{method:'POST',body:request}));assert.equal(copied.revision,before.revision+1);assert.notEqual(copied.teamspace.id,created.teamspace.id);assert.equal(copied.teamspace.role,'owner');assert.equal(copied.teamspace.name,request.name);assert.equal(copied.teamspace.memberCount,1);assert.equal(copied.teamspace.archivedAt,null);assert.deepEqual(copied.members.map(item=>[item.accountId,item.role,item.currentUser]),[['owner','owner',true]]);
 for(const key of ['description','visibility','defaultPermission'])assert.equal(copied.teamspace[key],created.teamspace[key]);
 const after=await fixtureState(f);assert.deepEqual(after.payload.pages,before.payload.pages);assert.deepEqual(after.payload.grants,before.payload.grants);assert.deepEqual(after.payload.teamspaces.find(item=>item.id===created.teamspace.id),before.payload.teamspaces[0]);assert.equal((after.payload.teamspacePages??[]).some(item=>item.teamspaceId===copied.teamspace.id),false);
 await responseMatches(template,'post',await f.request(path+'/duplicate',{method:'POST',body:request}),409);
 await documentedTeamspaceMutation(f,path+'/archive',teamspaceTemplate+'/archive',{archived:true});const archivedBefore=await fixtureState(f);
 const archived=await documentedTeamspaceMutation(f,path+'/duplicate',template,{name:'Archived copy',confirmSettingsOnly:true},{status:409});assert.equal(archived.error.code,'TEAMSPACE_ARCHIVED');assert.deepEqual(await fixtureState(f),archivedBefore);
});

test('documented content-blocks header advertises all three bounded parser features on every room route',async t=>{
 const f=fixture(t),{content}=await f.ready,headers={'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state','X-Yumunio-Room-Extensions':'block-transforms','X-Yumunio-Room-Content':'content-blocks'};
 assert.equal(validator(spec.components.parameters.RoomContent.schema).validate('content-blocks').valid,true);assert.equal(validator(spec.components.parameters.RoomContent.schema).validate('unknown').valid,false);for(const suffix of ['', '/open','/updates','/renew','/presence'])assert.ok(spec.paths[roomTemplate+suffix].parameters.some(row=>row.$ref==='#/components/parameters/RoomContent'));
 const opened=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:(await content.read('workspace','owner')).revision,protocol:2},headers}),201);assert.deepEqual(opened.supportedFeatures,['check-state','block-transforms','content-blocks']);
});

test('layout support is explicitly negotiated and documented for every room route',async t=>{
 const f=fixture(t),{content}=await f.ready,headers={'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state','X-Yumunio-Room-Extensions':'block-transforms','X-Yumunio-Room-Content':'content-blocks','X-Yumunio-Room-Layout':'block-layout'};
 assert.equal(validator(spec.components.parameters.RoomLayout.schema).validate('block-layout').valid,true);assert.equal(validator(spec.components.parameters.RoomLayout.schema).validate('unknown').valid,false);for(const suffix of ['', '/open','/updates','/renew','/presence'])assert.ok(spec.paths[roomTemplate+suffix].parameters.some(row=>row.$ref==='#/components/parameters/RoomLayout'));
 const opened=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:(await content.read('workspace','owner')).revision,protocol:2},headers}),201);assert.deepEqual(opened.supportedFeatures,['check-state','block-transforms','content-blocks','block-layout']);
});

test('documented settings and opaque reference registries match real updates, ACL projection and shared-state responses',async t=>{
 const f=fixture(t),{content}=await f.ready,headers={'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state','X-Yumunio-Room-Extensions':'block-transforms','X-Yumunio-Room-Content':'content-blocks','X-Yumunio-Room-Layout':'block-layout','X-Yumunio-Room-Settings':'block-settings','X-Yumunio-Room-References':'rich-references'};
 for(const name of ['RoomSettings','RoomReferences'])for(const suffix of ['', '/open','/updates','/renew','/presence'])assert.ok(spec.paths[roomTemplate+suffix].parameters.some(row=>row.$ref==='#/components/parameters/'+name));
 const opened=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:{expectedRevision:(await content.read('workspace','owner')).revision,protocol:2},headers}),201);assert.equal(opened.supportedFeatures.length,6);
 const doc=loadStructuredRoom(fromBase64(opened.update),opened.seed);let body;
 try{const vector=Y.encodeStateVector(doc);structuredRoomOperation(doc,opened.seed,{kind:'block-presentation',blockId:'body',presentation:{color:'blue'}});structuredRoomReferences(doc,opened.seed,{blockId:'body',text:'Original body',links:[{start:0,end:8,label:'Original',pageId:'page'}]});body={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(doc,vector)),references:opened.seed.references};}finally{doc.destroy();}
 requestMatches(roomTemplate+'/updates','post',body);const ack=await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body,headers}));assert.equal(Object.keys(ack.referenceTargets).length,1);
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...headers,'X-Yumunio-Room-Ticket':opened.ticket}}));
});

test('documented block-transforms advertisement, split/merge/convert ACK and check-only rejection match actual SQLite routes',async t=>{
 const f=fixture(t,{sourceBlock:true}),{content}=await f.ready,input={expectedRevision:(await content.read('workspace','owner')).revision,protocol:2},headers={'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state','X-Yumunio-Room-Extensions':'block-transforms'};
 assert.equal(validator(spec.components.parameters.RoomExtensions.schema).validate('block-transforms').valid,true);assert.equal(validator(spec.components.parameters.RoomExtensions.schema).validate('unknown').valid,false);for(const suffix of ['', '/open','/updates','/renew','/presence'])assert.ok(spec.paths[roomTemplate+suffix].parameters.some(row=>row.$ref==='#/components/parameters/RoomExtensions'));
 const opened=await responseMatches(roomTemplate+'/open','post',await f.request(roomPath+'/open',{method:'POST',body:input,headers}),201);assert.deepEqual(opened.supportedFeatures,['check-state','block-transforms']);assert.equal(validator(schema('RoomOpenResponse')).validate({...opened,supportedFeatures:['unknown']}).valid,false);
 const doc=loadStructuredRoom(fromBase64(opened.update),opened.seed);let body;try{const vector=Y.encodeStateVector(doc);structuredRoomOperation(doc,opened.seed,{kind:'split',blockId:'body',newBlockId:'split-tail',start:8,end:8});structuredRoomText(doc,'block:split-tail','Peer body',{base:opened.seed});structuredRoomOperation(doc,opened.seed,{kind:'merge',blockId:'split-tail',previousId:'body'});structuredRoomOperation(doc,opened.seed,{kind:'convert',blockId:'body',type:'heading',data:{level:2}});body={epoch:opened.epoch,ticket:opened.ticket,update:toBase64(Y.encodeStateAsUpdate(doc,vector))};}finally{doc.destroy();}
 requestMatches(roomTemplate+'/updates','post',body);await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body,headers:{'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state'}}),409);const ack=await responseMatches(roomTemplate+'/updates','post',await f.request(roomPath+'/updates',{method:'POST',body,headers}));assert.equal(ack.acknowledged,true);const saved=await content.read('workspace','owner');assert.deepEqual(saved.payload.rooms[0].features,['block-transforms']);assert.equal(saved.payload.pages[0].document.blocks[0].type,'heading');assert.equal(saved.payload.pages[0].document.blocks[0].data.text,'OriginalPeer body');
 await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{'X-Yumunio-Room-Protocol':'2','X-Yumunio-Room-Features':'check-state','X-Yumunio-Room-Ticket':opened.ticket}}),409);await responseMatches(roomTemplate,'get',await f.request(roomPath,{headers:{...headers,'X-Yumunio-Room-Ticket':opened.ticket}}));
});

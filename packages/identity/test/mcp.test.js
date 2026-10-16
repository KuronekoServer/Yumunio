import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createMcpApi,readMcpConfig,MCP_PROTOCOL_VERSION} from '../src/mcp.js';

const origin='https://mcp-fixture.invalid';
const failure=(code,status)=>Object.assign(new Error('Secret internal failure must not escape'),{code,status});
function fixture({scopes=['page:read','document:read','document:write','mcp:connect'],enabled=true}={}){
 const calls=[],pages=new Map([['page-a',{schemaVersion:1,page:{id:'page-a',title:'Synthetic page',version:1},document:{blocks:[{id:'text-a',type:'paragraph',data:{text:'Literal <script>text</script>'}}],omittedBlocks:0}}],['page-b',{schemaVersion:1,page:{id:'page-b',title:'Other page',version:1}}]]);
 let revoked=false,customError;
 const scopeFor=authorization=>{if(revoked||!['Bearer fixture-a','Bearer fixture-b'].includes(authorization))throw failure('API_TOKEN_UNAVAILABLE',401);return{pageId:authorization==='Bearer fixture-a'?'page-a':'page-b',scopes:[...scopes]};};
 const actions={async authorize({authorization,pageId,scope}){const value=scopeFor(authorization);if(pageId&&pageId!==value.pageId||!value.scopes.includes(scope))throw failure('API_TOKEN_UNAVAILABLE',401);return value;},async execute(value){calls.push(structuredClone(value));if(customError)throw customError;const capability=scopeFor(value.authorization);if(value.pageId!==capability.pageId||value.requiredScopes?.some(scope=>!capability.scopes.includes(scope)))throw failure('API_TOKEN_UNAVAILABLE',401);const page=pages.get(value.pageId);if(value.action==='document.write'){if(!capability.scopes.includes('document:write'))throw failure('API_TOKEN_UNAVAILABLE',401);if(value.input.expectedVersion!==page.page.version)throw failure('CONTENT_CONFLICT',409);if(value.input.title)page.page.title=value.input.title;page.page.version++;}return structuredClone(page);}};
 const api=createMcpApi({actions,origin,enabled,resolveSession:async request=>request.headers.get('cookie')==='fixture=session'?{user:{id:'fixture-account',emailVerified:true}}:null});
 const request=(message,{token='fixture-a',method='POST',headers={},body}={})=>api(new Request(origin+'/api/mcp',{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),Accept:'application/json, text/event-stream','Content-Type':'application/json',...headers},...(!['GET','HEAD'].includes(method)?{body:body??JSON.stringify(message)}:{})}));
 const client=async(token='fixture-a')=>{const client=new Client({name:'fixture-client',version:'1.0.0'}),transport=new StreamableHTTPClientTransport(new URL(origin+'/api/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}},fetch:(input,init)=>api(new Request(input,init))});await client.connect(transport);return client;};
 return{api,request,client,calls,pages,set revoked(value){revoked=value;},set customError(value){customError=value;}};
}
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'fixture',version:'1'}}};

test('MCP uses the official SDK client for stateless initialize, tools, resources and optimistic writes',async t=>{
 const f=fixture(),client=await f.client();t.after(()=>client.close());
 assert.equal(client.getServerVersion().name,'yumunio');
 const tools=await client.listTools();assert.deepEqual(tools.tools.map(row=>row.name),['get_page','get_document','update_page']);assert.equal(tools.tools[2].annotations.destructiveHint,true);
 const result=await client.callTool({name:'get_document',arguments:{}});assert.equal(result.structuredContent.document.blocks[0].data.text,'Literal <script>text</script>');
 const resources=await client.listResources();assert.equal(resources.resources.length,1);const resource=await client.readResource({uri:resources.resources[0].uri});assert.equal(JSON.parse(resource.contents[0].text).page.id,'page-a');
 const updated=await client.callTool({name:'update_page',arguments:{expectedVersion:1,title:'Edited through MCP'}});assert.equal(updated.structuredContent.page.version,2);assert.equal(updated.structuredContent.page.title,'Edited through MCP');
 const conflict=await client.callTool({name:'update_page',arguments:{expectedVersion:1,title:'Stale'}});assert.equal(conflict.isError,true);assert.equal(conflict.structuredContent.error.code,'CONTENT_CONFLICT');assert.equal(f.pages.get('page-a').page.title,'Edited through MCP');
 const untitled=await client.callTool({name:'update_page',arguments:{expectedVersion:2,title:''}});assert.equal(untitled.isError,undefined);assert.equal(f.calls.at(-1).input.title,'');
 assert.ok(f.calls.every(call=>JSON.stringify(call.requiredScopes)==='["mcp:connect"]'));
});
test('MCP discovery requires explicit scope and never accepts a cookie as a bearer',async()=>{
 const f=fixture({scopes:['page:read','document:read']});assert.equal((await f.request(initialize)).status,401);assert.equal((await f.request(initialize,{token:null,headers:{Cookie:'fixture=session'}})).status,401);assert.equal(f.calls.length,0);
});
test('read-only MCP grants expose no write tool and current revocation applies to every request',async t=>{
 const f=fixture({scopes:['page:read','document:read','mcp:connect']}),client=await f.client();t.after(()=>client.close());assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['get_page','get_document']);await assert.rejects(client.callTool({name:'update_page',arguments:{expectedVersion:1,title:'Forbidden'}}));assert.equal(f.calls.length,0);
 f.revoked=true;assert.equal((await f.request({jsonrpc:'2.0',id:5,method:'tools/list'},{headers:{'MCP-Protocol-Version':MCP_PROTOCOL_VERSION}})).status,401);
});
test('page-only MCP exposes a single page tool and isolates concurrent token-bound requests',async t=>{
 const f=fixture({scopes:['page:read','mcp:connect']}),a=await f.client(),b=await f.client('fixture-b');t.after(async()=>{await a.close();await b.close();});assert.deepEqual((await a.listTools()).tools.map(row=>row.name),['get_page']);
 const[one,two]=await Promise.all([a.callTool({name:'get_page',arguments:{}}),b.callTool({name:'get_page',arguments:{}})]);assert.equal(one.structuredContent.page.id,'page-a');assert.equal(two.structuredContent.page.id,'page-b');const denied=await b.callTool({name:'get_page',arguments:{pageId:'page-a'}});assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.code,'API_TOKEN_UNAVAILABLE');
});
test('transport rejects foreign origins, malformed and oversized bodies, batches and unsupported versions',async()=>{
 const f=fixture();assert.equal((await f.request(initialize,{headers:{Origin:'https://foreign.invalid'}})).status,403);assert.equal((await f.request(initialize,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
 for(const body of ['[{}]','{invalid',new Uint8Array([0xc3,0x28])])assert.equal((await f.request(null,{body})).status,400);
 assert.equal((await f.request(null,{body:'x'.repeat(256001)})).status,413);assert.equal((await f.request(initialize,{headers:{'Content-Type':'text/plain'}})).status,400);assert.equal((await f.request(initialize,{headers:{'MCP-Protocol-Version':'unsupported'}})).status,400);
 assert.equal((await f.request(initialize,{headers:{Accept:'application/json'}})).status,406);assert.equal((await f.request(null,{method:'GET'})).status,405);assert.equal((await f.request(null,{method:'DELETE'})).status,405);assert.equal((await f.request(initialize,{headers:{'mcp-session-id':'unowned-session'}})).status,400);assert.equal(f.calls.length,0);
});
test('tool validation rejects unknown input and execution errors omit secret exception messages',async t=>{
 const f=fixture(),client=await f.client();t.after(()=>client.close());await assert.rejects(client.callTool({name:'update_page',arguments:{expectedVersion:1,title:'Known',injected:'Hidden'}}));await assert.rejects(client.callTool({name:'update_page',arguments:{expectedVersion:0,title:'Known'}}));assert.equal(f.calls.length,0);f.customError=failure('STORAGE_FAILURE',503);const result=await client.callTool({name:'get_page',arguments:{}});assert.equal(result.isError,true);assert.doesNotMatch(JSON.stringify(result),/Secret internal/);
});
test('MCP configuration is account-bound and disabled state creates no external capability',async()=>{
 assert.deepEqual(readMcpConfig({}),{enabled:false});assert.deepEqual(readMcpConfig({YUMUNIO_MCP_ENABLED:'true'}),{enabled:true});assert.throws(()=>readMcpConfig({YUMUNIO_MCP_ENABLED:'yes'}));const f=fixture({enabled:false});assert.equal((await f.request(initialize)).status,503);
 const read=headers=>f.api(new Request(origin+'/api/integrations/mcp',{headers}));assert.equal((await read({})).status,401);assert.equal((await read({Cookie:'fixture=session','X-Yumunio-Expected-Account':'other'})).status,404);const response=await read({Cookie:'fixture=session','X-Yumunio-Expected-Account':'fixture-account'});assert.deepEqual(await response.json(),{enabled:false,endpoint:'/api/mcp',protocolVersion:MCP_PROTOCOL_VERSION,authentication:'personal-token'});assert.equal(response.headers.get('cache-control'),'no-store');
});

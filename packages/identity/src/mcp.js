import {z} from 'zod';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {CfWorkerJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/cfworker';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {assertId} from '@yumunio/domain';

export const MCP_PROTOCOL_VERSION='2025-11-25';
const LIMIT=256000;
const policy={'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','X-Robots-Tag':'noindex, nofollow, noarchive'};
const json=(value,status=200,extra={})=>Response.json(value,{status,headers:{...policy,...extra}});
const mcpFlagSchema=z.enum(['true','false']);
export function readMcpConfig(env={}){const flag=env.YUMUNIO_MCP_ENABLED;if(flag===undefined||flag==='')return{enabled:false};const result=mcpFlagSchema.safeParse(flag);if(result.success)return{enabled:result.data==='true'};throw new Error('Invalid MCP configuration.');}
function problem(code,status){throw Object.assign(new Error(code),{code,status});}
async function readMessage(request){
 if((request.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='application/json'||!request.body)problem('MCP_INVALID_REQUEST',400);
 const reader=request.body.getReader(),parts=[];let length=0;
 try{for(;;){const{done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>LIMIT){await reader.cancel().catch(()=>{});problem('MCP_REQUEST_TOO_LARGE',413);}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
 let message;try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{problem('MCP_INVALID_JSON',400);}
 if(!message||typeof message!=='object'||Array.isArray(message))problem('MCP_INVALID_REQUEST',400);
 return message;
}
const pageIdSchema={type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'};
const inputSchema={type:'object',properties:{pageId:pageIdSchema},additionalProperties:false};
const writeSchema={type:'object',properties:{pageId:pageIdSchema,expectedVersion:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-1},title:{type:'string',maxLength:240},blocks:{type:'array',maxItems:1000,items:{type:'object'}}},required:['expectedVersion'],anyOf:[{required:['title']},{required:['blocks']}],additionalProperties:false};
const editSchema={type:'object',properties:{pageId:pageIdSchema,expectedVersion:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER-1},operations:{type:'array',minItems:1,maxItems:100,items:{oneOf:[{type:'object',properties:{type:{const:'append'},parentId:{anyOf:[pageIdSchema,{type:'null'}]},blocks:{type:'array',minItems:1,maxItems:1000,items:{type:'object'}}},required:['type','blocks'],additionalProperties:false},{type:'object',properties:{type:{const:'update'},blockId:pageIdSchema,data:{type:'object'}},required:['type','blockId','data'],additionalProperties:false},{type:'object',properties:{type:{const:'delete'},blockId:pageIdSchema},required:['type','blockId'],additionalProperties:false}]}}},required:['expectedVersion','operations'],additionalProperties:false};
function tool(name,title,description,schema,{readOnly=true}={}){return{name,title,description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly,openWorldHint:false}};}
const definitions=Object.freeze([
 tool('get_page','Read page','Read the title and current version of the single page authorized by this token.',inputSchema),
 tool('get_document','Read document','Read supported text blocks of the authorized page. Omitted blocks are reported; source and private metadata are not returned.',inputSchema),
 tool('update_page','Update page','Update the authorized page title or supported text blocks. Read the current version first and provide expectedVersion. Conflicts are never retried automatically. Body replacement is refused when hidden or unsupported blocks would be lost.',writeSchema,{readOnly:false}),
 tool('edit_blocks','Edit page blocks','Atomically append, update or delete supported text blocks of the authorized page. Read the version first. New block IDs are generated when omitted. Unrelated and unsupported blocks are preserved; deleting a subtree containing omitted blocks is refused.',editSchema,{readOnly:false})
]);
const safeError=error=>({error:{code:typeof error?.code==='string'&&/^[A-Z_]{1,80}$/.test(error.code)?error.code:'MCP_UNAVAILABLE',message:'The requested page operation could not be completed.'},status:Number.isSafeInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:503});

/** Stateless authenticated MCP transport. No model invocation, cookie-to-token fallback or shared sessions. */
export function createMcpApi({actions,origin,enabled=false,resolveSession}={}){
 if(new URL(origin).origin!==origin||typeof enabled!=='boolean'||!actions||typeof actions.authorize!=='function'||typeof actions.execute!=='function'||typeof resolveSession!=='function')throw new Error('Invalid MCP service configuration.');
 return async request=>{
  let server;
  try{
   const url=new URL(request.url),management=url.pathname==='/api/integrations/mcp';
   if(url.origin!==origin||url.search||url.hash||!management&&url.pathname!=='/api/mcp')return json({error:{code:'MCP_NOT_FOUND'}},404);
   if(request.headers.has('origin')&&request.headers.get('origin')!==origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site')))return json({error:{code:'ORIGIN_REJECTED'}},403);
   if(management){
    if(request.method!=='GET')return json({error:{code:'METHOD_NOT_ALLOWED'}},405,{Allow:'GET'});
    if(request.headers.has('authorization'))return json({error:{code:'ORIGIN_REJECTED'}},403);
    const session=await resolveSession(request);if(!session?.user?.id||session.user.emailVerified!==true)return json({error:{code:'UNAUTHORIZED'}},401);
    let expected;try{expected=assertId(request.headers.get('x-yumunio-expected-account'));}catch{return json({error:{code:'INVALID_MCP_REQUEST'}},400);}
    if(expected!==session.user.id)return json({error:{code:'MCP_NOT_FOUND'}},404);
    return json({enabled,endpoint:'/api/mcp',protocolVersion:MCP_PROTOCOL_VERSION,authentication:'personal-token'});
   }
   if(!enabled)return json({error:{code:'MCP_DISABLED'}},503);
   const authorization=request.headers.get('authorization');
   const capability=await actions.authorize({authorization,scope:'mcp:connect'});
   if(!['POST','GET','DELETE'].includes(request.method))return json({error:{code:'METHOD_NOT_ALLOWED'}},405,{Allow:'POST'});
   if(request.method!=='POST')return json({error:{code:'METHOD_NOT_ALLOWED'}},405,{Allow:'POST'});
   if(request.headers.has('mcp-session-id'))return json({error:{code:'MCP_STATELESS_ENDPOINT'}},400);
   const version=request.headers.get('mcp-protocol-version');
   if(version&&!['2025-03-26','2025-06-18',MCP_PROTOCOL_VERSION].includes(version))return json({error:{code:'MCP_UNSUPPORTED_PROTOCOL_VERSION'}},400);
   const message=await readMessage(request),validator=new CfWorkerJsonSchemaValidator();
   const allowed=definitions.filter(row=>row.name==='get_page'||row.name==='get_document'&&capability.scopes.includes('document:read')||['update_page','edit_blocks'].includes(row.name)&&capability.scopes.includes('document:write'));
   const resource='yumunio://pages/'+encodeURIComponent(capability.pageId)+'/document';
   const output=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
   const execute=(action,pageId,input)=>actions.execute({authorization,pageId:pageId??capability.pageId,action,input,requiredScopes:['mcp:connect']});
   server=new Server({name:'yumunio',title:'Yumunio',version:'0.1.0'},{capabilities:{tools:{},...(capability.scopes.includes('document:read')?{resources:{}}:{})},jsonSchemaValidator:validator});
   server.setRequestHandler(ListToolsRequestSchema,()=>({tools:allowed}));
   const validators=new Map(allowed.map(row=>[row.name,validator.getValidator(row.inputSchema)]));
   server.setRequestHandler(CallToolRequestSchema,async rpc=>{
    const selected=allowed.find(row=>row.name===rpc.params.name),args=rpc.params.arguments??{};
    if(!selected||!validators.get(selected.name)(args).valid)throw new McpError(ErrorCode.InvalidParams,'Invalid tool or arguments.');
    try{if(selected.name==='get_page')return output(await execute('page.read',args.pageId));if(selected.name==='get_document')return output(await execute('document.read',args.pageId));const{pageId,...input}=args;return output(await execute(selected.name==='edit_blocks'?'blocks.edit':'document.write',pageId,input));}
    catch(error){return{...output(safeError(error)),isError:true};}
   });
   if(capability.scopes.includes('document:read')){
    server.setRequestHandler(ListResourcesRequestSchema,()=>({resources:[{uri:resource,name:'page-document',title:'Authorized page document',mimeType:'application/json'}]}));
    server.setRequestHandler(ReadResourceRequestSchema,async rpc=>{if(rpc.params.uri!==resource)throw new McpError(ErrorCode.InvalidParams,'Resource is not available.');try{return{contents:[{uri:resource,mimeType:'application/json',text:JSON.stringify(await execute('document.read',capability.pageId))}]};}catch{throw new McpError(ErrorCode.InvalidRequest,'Resource is not available.');}});
   }
   const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:LIMIT});
   await server.connect(transport);
   const response=await transport.handleRequest(request,{parsedBody:message});
   const headers=new Headers(response.headers);for(const[name,value]of Object.entries(policy))headers.set(name,value);
   return new Response(response.status===202||response.status===204?null:await response.arrayBuffer(),{status:response.status,headers});
  }catch(error){const value=safeError(error);return json({error:value.error},value.status,value.status===401?{'WWW-Authenticate':'Bearer realm="Yumunio MCP"'}:{});}
  finally{await server?.close().catch(()=>{});}
 };
}

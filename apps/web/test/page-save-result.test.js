import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSavedPage,pageBlocksEqual} from '../public/page-save-result.js';
import {createAccountContentApi} from '../../../packages/identity/src/content.js';
const context={workspaceId:'workspace',pageId:'page'},stamp='2026-10-16T00:00:00.000Z';
const block=()=>({id:'block',type:'paragraph',data:{text:'Hello 😀 garden',marks:[{start:0,end:5,styles:['bold']}],custom:{value:'preserved',flag:false}},children:[{id:'child',type:'quote',data:{text:'Nested'}}]});
const sent=()=>({expectedRevision:7,expectedVersion:2,title:'  Garden  ',blocks:[block(),{id:'source',type:'code',data:{text:'# Original',language:'markdown',purpose:'import-source'}}]});
function response(basis=sent()) {return{revision:8,page:{id:'page',workspaceId:'workspace',title:basis.title,parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null,version:3,capabilities:['read','editBody']},document:{pageId:'page',workspaceId:'workspace',version:3,updatedAt:stamp,blocks:structuredClone(basis.blocks)},attachments:[]};}
const rejected=(basis,value,options=context)=>assert.throws(()=>validateSavedPage(basis,value,options),{code:'INVALID_PAGE_SAVE_RESULT',message:'INVALID_PAGE_SAVE_RESULT'});

test('known ACK retains exact whitespace and empty titles, nested source metadata and independent input copies',()=>{
 for(const title of ['  Garden  ','', '   ']){const basis={...sent(),title},value=response(basis),checked=validateSavedPage(basis,value,context);assert.deepEqual(checked,value);checked.document.blocks[0].data.text='changed';assert.equal(value.document.blocks[0].data.text,'Hello 😀 garden');assert.equal(basis.blocks[0].data.text,'Hello 😀 garden');}
 const basis=sent(),value=response(basis);value.document.blocks[0].data={custom:{flag:false,value:'preserved'},marks:value.document.blocks[0].data.marks,text:value.document.blocks[0].data.text};assert.doesNotThrow(()=>validateSavedPage(basis,value,context));
});
test('ACK must advance exactly one captured aggregate revision and document version',()=>{
 const basis=sent();for(const change of [value=>value.revision=7,value=>value.revision=9,value=>value.document.version=2,value=>value.document.version=4,value=>value.page.version=4,value=>value.revision='8',value=>value.document.version=NaN]){const value=response(basis);change(value);rejected(basis,value);}
 for(const key of ['expectedRevision','expectedVersion'])rejected({...basis,[key]:Number.MAX_SAFE_INTEGER},response(basis));
});
test('cross-page, cross-workspace, wrong-title and malformed identity projections are unknown ACKs',()=>{
 const basis=sent();for(const change of [value=>value.page.id='another',value=>value.document.pageId='another',value=>value.page.workspaceId='another',value=>value.document.workspaceId='another',value=>value.page.title='Garden',value=>value.page.parentId='page',value=>value.page.trashedAt=stamp,value=>value.page.capabilities=[],value=>value.page.capabilities.push('read'),value=>value.page.updatedAt='bad',value=>value.document.updatedAt='2026-10-16T00:00:01.000Z',value=>value.secret='unexpected',value=>value.page.collectionId='unsafe/id']){const value=response(basis);change(value);rejected(basis,value);}
 rejected(basis,response(basis),{});
 assert.throws(()=>validateSavedPage(basis,response(basis),{workspaceId:'another',pageId:'page'}),{code:'INVALID_PAGE_SAVE_RESULT'});
});

test('save ACKs retain optional personal, shared, legacy and teamspace placement projections',()=>{
 const basis=sent();
 for(const [teamspaceId,sidebarSection]of [[null,'personal'],[null,'shared'],[null,'legacy'],['team-a','teamspace']]){
  const value=response(basis);Object.assign(value.page,{teamspaceId,sidebarSection});const checked=validateSavedPage(basis,value,context);assert.deepEqual(checked,value);assert.equal(checked.page.teamspaceId,teamspaceId);assert.equal(checked.page.sidebarSection,sidebarSection);
 }
 const legacy=response(basis);assert.doesNotThrow(()=>validateSavedPage(basis,legacy,context));
 for(const fields of [{teamspaceId:null},{teamspaceId:'team-a'},{sidebarSection:'personal'}]){const value=response(basis);Object.assign(value.page,fields);assert.doesNotThrow(()=>validateSavedPage(basis,value,context));}
});

test('malformed placement metadata cannot turn a successful response into a confirmed save',()=>{
 const basis=sent();
 for(const teamspaceId of ['',false,0,[],{},'unsafe/team','team a','x'.repeat(129),undefined]){const value=response(basis);value.page.teamspaceId=teamspaceId;rejected(basis,value);}
 for(const sidebarSection of ['',null,false,0,[],{},'private','TEAMSPACE','personal ',undefined]){const value=response(basis);value.page.sidebarSection=sidebarSection;rejected(basis,value);}
 const value=response(basis);let reads=0;Object.defineProperty(value.page,'teamspaceId',{enumerable:true,get(){reads++;return'team-a';}});rejected(basis,value);assert.equal(reads,0);
});
test('ACK cannot silently change text, formatting, source blocks, order, nested structure or opaque JSON metadata',()=>{
 const basis=sent();for(const change of [value=>value.document.blocks[0].data.text='Replaced',value=>value.document.blocks[0].data.marks=[],value=>delete value.document.blocks[0].data.custom,value=>value.document.blocks[0].data.custom.flag=true,value=>value.document.blocks[1].data.text='source replaced',value=>value.document.blocks.reverse(),value=>value.document.blocks[0].children=[],value=>value.document.blocks[0].id='other-block',value=>value.document.blocks[0].extra='invented']){const value=response(basis);change(value);rejected(basis,value);}
});
function linkedBasis(unavailable=false){const basis=sent();basis.blocks[0].children[0].data={text:'Target',links:[{start:0,end:6,label:'Target',...(unavailable?{unavailable:true}:{pageId:'target',attachmentId:'attachment',fragment:'heading'})}]};return basis;}
test('backend may redact an existing exact nested link but cannot expose a previously unavailable target',()=>{
 const basis=linkedBasis(),value=response(basis);value.document.blocks[0].children[0].data.links=[{start:0,end:6,label:'Target',unavailable:true}];const checked=validateSavedPage(basis,value,context);assert.deepEqual(checked.document.blocks[0].children[0].data.links,value.document.blocks[0].children[0].data.links);assert.equal(basis.blocks[0].children[0].data.links[0].pageId,'target');
 const hidden=linkedBasis(true);assert.doesNotThrow(()=>validateSavedPage(hidden,response(hidden),context));const exposed=response(hidden);exposed.document.blocks[0].children[0].data.links=[{start:0,end:6,label:'Target',pageId:'invented-target'}];rejected(hidden,exposed);
});
test('link additions, deletion, retargeting, changed fragments and forged redactions cannot confirm a save',()=>{
 const basis=linkedBasis();for(const change of [link=>link.pageId='another-target',link=>link.attachmentId='another-attachment',link=>link.fragment='other-heading',link=>{link.unavailable=true;},link=>{delete link.pageId;delete link.attachmentId;delete link.fragment;link.unavailable=true;link.label='Forged';},link=>link.end=5]){const value=response(basis);change(value.document.blocks[0].children[0].data.links[0]);rejected(basis,value);}
 const removed=response(basis);removed.document.blocks[0].children[0].data.links=[];rejected(basis,removed);
 const added=response(sent());added.document.blocks[0].data.links=[{start:0,end:5,label:'Hello',pageId:'invented'}];rejected(sent(),added);
});
test('unsafe inline URLs, invalid UTF16 ranges and formatting on readonly source blocks are rejected even when echoed',()=>{
 for(const mutate of [basis=>basis.blocks[0].data.marks=[{start:0,end:5,styles:[],href:'javascript:alert(1)'}],basis=>basis.blocks[0].data.marks=[{start:6,end:7,styles:['bold']}],basis=>basis.blocks[1].data.marks=[{start:0,end:1,styles:['bold']}],basis=>basis.blocks[0].data.links=[{start:6,end:7,label:'\ud83d',pageId:'target'}]]){const basis=sent();mutate(basis);rejected(basis,response(basis));}
});
test('malformed JSON, accessors, duplicate block IDs, oversized data and invalid attachments fail without executing getters',()=>{
 const basis=sent();let reads=0;const value=response(basis);Object.defineProperty(value,'secret',{enumerable:true,get(){reads++;return'private';}});rejected(basis,value);assert.equal(reads,0);
 const cyclic=response(basis);cyclic.document.blocks[0].data.cycle=cyclic;rejected(basis,cyclic);
 const duplicate=sent();duplicate.blocks[1].id=duplicate.blocks[0].id;rejected(duplicate,response(duplicate));
 const huge=sent();huge.blocks[0].data.text='x'.repeat(1048577);rejected(huge,response(huge));
 for(const attachment of [{id:'asset',name:'a.txt',mediaType:'text/plain',size:-1},{id:'asset',name:'a.txt',mediaType:'text/plain',size:1,objectKey:'private-location'}]){const candidate=response(basis);candidate.attachments=[attachment];rejected(basis,candidate);}
 const candidate=response(basis);candidate.attachments=[{id:'asset',name:'a.txt',mediaType:'text/plain',size:1}];assert.doesNotThrow(()=>validateSavedPage(basis,candidate,context));candidate.attachments.push({...candidate.attachments[0]});rejected(basis,candidate);
});

test('production content API emits accepted exact title/version ACKs and projects inaccessible existing links',async()=>{
 for(const title of ['  Garden  ','']){
  let revision=7;const principal={id:'membership',accountId:'account',email:'fixture@example.invalid',emailVerified:true,role:'owner'};
  const page=id=>({id,workspaceId:'workspace',title:'Before',parentId:null,createdAt:stamp,updatedAt:stamp,trashedAt:null});
  const visibleBlock={id:'block',type:'paragraph',data:{text:'Target',links:[{start:0,end:6,label:'Target',pageId:'hidden'}]}};
  let payload={schemaVersion:1,pages:[{page:page('page'),document:{pageId:'page',workspaceId:'workspace',version:2,updatedAt:stamp,blocks:[visibleBlock]},inheritPermissions:false},{page:page('hidden'),document:{pageId:'hidden',workspaceId:'workspace',version:1,updatedAt:stamp,blocks:[]},inheritPermissions:false}],grants:[{id:'grant',workspaceId:'workspace',pageId:'page',accountId:'account',permission:'full',includeDescendants:false,status:'active'}],grantBindings:[{grantId:'grant',membershipId:'membership'}]};
  const store={async read(){return{revision,payload:structuredClone(payload),principals:[principal]};},async write(workspaceId,accountId,input){assert.equal(workspaceId,'workspace');assert.equal(accountId,'account');assert.equal(input.expectedRevision,revision);payload=structuredClone(input.payload);return{revision:++revision};}};
  const api=createAccountContentApi({store,origin:'https://page-save.fixture.invalid',resolveSession:async()=>({user:{id:'account',emailVerified:true}}),now:()=>stamp});
  const basis={expectedRevision:7,expectedVersion:2,title,blocks:[{...visibleBlock,data:{text:'Target',links:[{start:0,end:6,label:'Target',unavailable:true}]}}]};
  const result=await api(new Request('https://page-save.fixture.invalid/api/content/workspaces/workspace/pages/page',{method:'PATCH',headers:{Origin:'https://page-save.fixture.invalid','Content-Type':'application/json','X-Yumunio-Expected-Account':'account'},body:JSON.stringify(basis)}));assert.equal(result.status,200,await result.clone().text());const ack=await result.json();assert.deepEqual(validateSavedPage(basis,ack,context),ack);assert.equal(ack.page.title,title);assert.equal(payload.pages[0].document.blocks[0].data.links[0].pageId,'hidden');
 }
});

test('block equality ignores object key order without changing content, array order or inputs',()=>{
 const before=[{id:'block',type:'paragraph',data:{text:'Garden',custom:{a:0,b:false,c:null},marks:[{start:0,end:6,styles:['bold','italic']}]},children:[{id:'child',type:'paragraph',data:{text:''}}]}];
 const reordered=[{children:[{data:{text:''},type:'paragraph',id:'child'}],data:{marks:[{styles:['bold','italic'],end:6,start:0}],custom:{c:null,b:false,a:0},text:'Garden'},type:'paragraph',id:'block'}];
 const captured=structuredClone(before);assert.equal(pageBlocksEqual(before,reordered),true);assert.deepEqual(before,captured);assert.equal(pageBlocksEqual([],[]),true);assert.equal(pageBlocksEqual(null,[]),false);
 for(const mutate of [blocks=>blocks[0].data.text='Garden ',blocks=>blocks[0].data.custom.a='0',blocks=>delete blocks[0].data.custom.c,blocks=>blocks[0].data.marks[0].styles.reverse(),blocks=>blocks[0].children.push({id:'next',type:'paragraph',data:{text:''}})]){const changed=structuredClone(reordered);mutate(changed);assert.equal(pageBlocksEqual(before,changed),false);}
 assert.equal(pageBlocksEqual([before[0],{id:'other',type:'divider'}],[{id:'other',type:'divider'},before[0]]),false);
});
test('block equality keeps a redacted link distinct from the previously visible target',()=>{
 const visible=linkedBasis().blocks,redacted=structuredClone(visible);redacted[0].children[0].data.links=[{start:0,end:6,label:'Target',unavailable:true}];assert.equal(pageBlocksEqual(visible,redacted),false);assert.equal(pageBlocksEqual(redacted,structuredClone(redacted)),true);
});

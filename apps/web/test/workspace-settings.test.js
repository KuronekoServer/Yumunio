import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsLocation,importHref,loadWorkspaceSettings} from '../public/workspace-settings-model.js';

function fixture({role='member',verified=true,current='account-a',currentVerified=true,list=[{id:'studio',name:'設定<script>literal</script>'}],config={enabled:true,workspaceContent:true},metadata={}}={}){
 const calls=[];
 const request=async(path,options={})=>{
  calls.push({path,options});
  if(path==='/api/auth/config')return config;
  if(path==='/api/auth/get-session')return {user:{id:calls.filter(item=>item.path===path).length===1?'account-a':current,name:'ホーム',emailVerified:calls.filter(item=>item.path===path).length===1?verified:currentVerified}};
  if(path==='/api/auth/organization/list')return list;
  if(path==='/api/content/workspaces/studio/pages')return {workspaceId:'studio',revision:4,role,pages:[],attachmentsEnabled:true,...metadata};
  throw Error('Unexpected request');
 };
 return {calls,request};
}
test('settings links preserve the selected workspace and permit only explicit sources',()=>{
 assert.deepEqual(settingsLocation('https://example.invalid/workspace-settings?workspace=studio&section=import'),{workspaceId:'studio',section:'import'});
 assert.equal(importHref('team:studio','notion'),'/import?workspace=team%3Astudio&source=notion');
 assert.equal(importHref('studio','appflowy'),'/import?workspace=studio&source=appflowy');
 for(const source of ['https://evil.invalid','../notion','','Notion'])assert.throws(()=>importHref('studio',source));
});
test('ambiguous and unsafe workspace query values fail before requests',()=>{
 for(const query of ['', '?workspace=../studio','?workspace=studio&workspace=other','?workspace=%3Cscript%3E'])assert.throws(()=>settingsLocation('https://example.invalid/workspace-settings'+query));
});
test('verified current membership returns a minimal literal settings context with fixed expected account',async()=>{
 const f=fixture(),value=await loadWorkspaceSettings({workspaceId:'studio',request:f.request});
 assert.equal(value.workspace.name,'設定<script>literal</script>');
 assert.equal(value.user.name,'ホーム');
 assert.equal(value.canImport,true);
 assert.equal(f.calls.find(item=>item.path.endsWith('/pages')).options.headers['X-Yumunio-Expected-Account'],'account-a');
 assert.deepEqual(Object.keys(value).sort(),['attachmentsEnabled','canImport','role','user','workspace']);
 assert.deepEqual(Object.keys(value.user).sort(),['id','name']);
 assert.ok(f.calls.every(item=>!item.options.method));
});
test('guest keeps the current workspace context and has no import action',async()=>{
 const f=fixture({role:'guest'}),value=await loadWorkspaceSettings({workspaceId:'studio',request:f.request});
 assert.equal(value.canImport,false);
 assert.equal(value.role,'guest');
});
test('disabled accounts and unverified sessions never request workspace content',async()=>{
 const disabled=fixture({config:{enabled:false}});
 await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',request:disabled.request}),{code:'ACCOUNTS_DISABLED'});
 assert.equal(disabled.calls.length,1);
 const unverified=fixture({verified:false});
 await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',request:unverified.request}),{code:'VERIFY_EMAIL'});
 assert.equal(unverified.calls.length,2);
});
test('unknown, missing and duplicate workspace memberships fail closed',async()=>{
 for(const list of [[],[{id:'studio',name:'A'},{id:'studio',name:'B'}],null]){
  const f=fixture({list});
  await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',request:f.request}));
  assert.ok(!f.calls.some(item=>item.path.endsWith('/pages')));
 }
});
test('a changed or unverified account after reading metadata cannot expose settings context',async()=>{
 for(const options of [{current:'account-b'},{currentVerified:false}]){const f=fixture(options);await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',request:f.request}),{code:'ACCOUNT_CHANGED'});}
});
test('mismatched workspace projection and unknown roles do not enable settings actions',async()=>{
 for(const metadata of [{workspaceId:'elsewhere'},{role:'administrator'},{revision:-1},{pages:null}]){
  const f=fixture({metadata});
  await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',request:f.request}),{code:'INVALID_RESPONSE'});
 }
});

test('embedded settings reject a different expected account before membership or page reads',async()=>{
 const f=fixture();
 await assert.rejects(loadWorkspaceSettings({workspaceId:'studio',expectedAccountId:'other-account',request:f.request}),{code:'ACCOUNT_CHANGED'});
 assert.deepEqual(f.calls.map(item=>item.path),['/api/auth/config','/api/auth/get-session']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountPreferenceSync} from '../public/preference-sync.js';
import {PreferencesStore} from '../public/preferences.js';
class MemoryStorage {values=new Map();blocked=false;getItem(key){return this.values.get(key)??null;}setItem(key,value){if(this.blocked)throw new Error('quota');this.values.set(key,value);}}
const snapshot=(extra={})=>({schemaVersion:1,themeId:'ocean',customColors:{},fontId:'system',locale:'ja',...extra});
function fixture({remote={revision:0,preferences:null}}={}){
  const storage=new MemoryStorage(),local=new PreferencesStore({storage,profileId:'account-a'}),calls=[];
  let account={id:'account-a',emailVerified:true},state=structuredClone(remote),hook=null;
  const fetcher=async(path,options)=>{
    const call={path,method:options.method,headers:options.headers,body:options.body?JSON.parse(options.body):null};calls.push(call);
    assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
    if(hook){const response=await hook(call);if(response)return response;}
    if(path==='/api/auth/get-session')return Response.json(account?{user:account}:null);
    assert.equal(path,'/api/preferences');
    if(call.headers['X-Yumunio-Expected-Account']!==account?.id)return Response.json({error:{code:'PREFERENCES_NOT_FOUND'}},{status:404});
    if(call.method==='GET')return Response.json(state);
    if(call.body.expectedRevision!==state.revision)return Response.json({error:{code:'PREFERENCES_CONFLICT'}},{status:409});
    state={revision:state.revision+1,preferences:structuredClone(call.body.preferences)};return Response.json(state);
  };
  const sync=new AccountPreferenceSync({fetcher});sync.setActor(account);
  return {sync,storage,local,calls,get state(){return structuredClone(state);},setState(value){state=structuredClone(value);},setAccount(value){account=value;},setHook(value){hook=value;}};
}
test('load reviews remote settings without local writes; apply and upload require separate explicit consent',async()=>{
  const f=fixture({remote:{revision:2,preferences:snapshot({locale:'en',fontId:'line-seed-jp'})}});
  const before=f.local.snapshot();const result=await f.sync.load();
  assert.equal(result.revision,2);assert.equal(f.sync.phase,'review');assert.deepEqual(f.local.snapshot(),before);assert.equal(f.storage.values.size,0);
  await assert.rejects(f.sync.applyRemote(f.local),e=>e.code==='PREFERENCE_SYNC_CONSENT_REQUIRED');
  await f.sync.applyRemote(f.local,{consent:true});assert.deepEqual(f.local.snapshot(),result.preferences);
  assert.equal(f.sync.phase,'applied');
  await assert.rejects(f.sync.save(f.local.snapshot()),e=>e.code==='PREFERENCE_SYNC_CONSENT_REQUIRED');
  const saved=await f.sync.save(f.local.snapshot(),{consent:true});assert.equal(saved.revision,3);assert.equal(f.sync.phase,'saved');
  assert.throws(()=>{result.preferences.locale='ja';});
});

test('new remote records require a prior load and never silently import brand or local settings',async()=>{
  const f=fixture();await assert.rejects(f.sync.save(snapshot(),{consent:true}),e=>e.code==='PREFERENCE_LOAD_REQUIRED');
  await f.sync.load();assert.equal(f.sync.phase,'empty');assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
  await assert.rejects(f.sync.applyRemote(f.local,{consent:true}),e=>e.code==='PREFERENCE_REMOTE_EMPTY');
  const saved=await f.sync.save(snapshot({themeId:'forest'}),{consent:true});assert.equal(saved.revision,1);
  assert.equal(f.local.snapshot().themeId,'light');
});

test('409 conflicts and malformed successful responses preserve local settings and the last reviewed server revision',async()=>{
  const f=fixture({remote:{revision:1,preferences:snapshot()}});await f.sync.load();const before=f.local.snapshot();
  f.setState({revision:2,preferences:snapshot({themeId:'forest'})});
  await assert.rejects(f.sync.save(before,{consent:true}),e=>e.status===409);
  assert.equal(f.sync.phase,'conflict');assert.equal(f.sync.revision,1);assert.deepEqual(f.local.snapshot(),before);
  assert.equal(f.sync.remote.themeId,'ocean');
  f.setHook(call=>call.path==='/api/preferences'&&call.method==='GET'?Response.json({revision:3,preferences:snapshot(),unexpectedSecret:'not adopted'}):null);
  await assert.rejects(f.sync.load(),e=>e.code==='INVALID_PREFERENCE_RESPONSE');
  assert.equal(f.sync.revision,1);assert.equal(f.sync.remote.themeId,'ocean');assert.deepEqual(f.local.snapshot(),before);
});

test('session changes are checked before upload and expected-account headers block the subsequent cookie race',async()=>{
  const f=fixture();await f.sync.load();f.setAccount({id:'account-b',emailVerified:true});
  await assert.rejects(f.sync.save(snapshot(),{consent:true}),e=>e.code==='ACCOUNT_CHANGED');
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
  f.setAccount({id:'account-a',emailVerified:true});
  f.setHook(call=>{if(call.path==='/api/preferences'&&call.method==='PUT')f.setAccount({id:'account-b',emailVerified:true});return null;});
  await assert.rejects(f.sync.save(snapshot(),{consent:true}),e=>e.code==='PREFERENCES_NOT_FOUND');
  assert.deepEqual(f.state,{revision:0,preferences:null});assert.equal(f.local.snapshot().themeId,'light');
});

test('changing the active account while a response is pending discards the previous account settings',async()=>{
  const f=fixture({remote:{revision:1,preferences:snapshot()}});let release;
  f.setHook(call=>call.path==='/api/preferences'?new Promise(resolve=>{release=resolve;}):null);
  const pending=f.sync.load();while(!release)await Promise.resolve();
  f.sync.setActor({id:'account-b',emailVerified:true});
  release(Response.json({revision:1,preferences:snapshot()}));
  await assert.rejects(pending,e=>e.code==='ACCOUNT_CHANGED');
  assert.equal(f.sync.revision,null);assert.equal(f.sync.remote,null);assert.equal(f.sync.actor.id,'account-b');assert.equal(f.local.snapshot().themeId,'light');
});

test('outgoing snapshots are captured before session IO and uncertain or mismatched responses never replace local data',async()=>{
  const f=fixture();await f.sync.load();let release;
  f.setHook(call=>call.path==='/api/auth/get-session'?new Promise(resolve=>{release=resolve;}):null);
  const value=snapshot({themeId:'paper'}),pending=f.sync.save(value,{consent:true});value.themeId='midnight';
  release(Response.json({user:{id:'account-a',emailVerified:true}}));await pending;
  assert.equal(f.state.preferences.themeId,'paper');assert.equal(f.local.snapshot().themeId,'light');
  f.setHook(call=>{if(call.path==='/api/preferences'&&call.method==='PUT')throw new Error('transport private detail');return null;});
  await assert.rejects(f.sync.save(snapshot(),{consent:true}),e=>e.code==='PREFERENCE_NETWORK_UNCERTAIN');
  assert.equal(f.sync.phase,'uncertain');assert.equal(f.sync.revision,1);assert.equal(f.local.snapshot().themeId,'light');
  f.setHook(call=>call.path==='/api/preferences'&&call.method==='PUT'?Response.json({revision:2,preferences:snapshot({themeId:'midnight'})}):null);
  await assert.rejects(f.sync.save(snapshot(),{consent:true}),e=>e.code==='INVALID_PREFERENCE_RESPONSE');
  assert.equal(f.sync.revision,1);assert.equal(f.local.snapshot().themeId,'light');
});

test('remote application is confined to the matching profile and storage failures leave its current data intact',async()=>{
  const f=fixture({remote:{revision:1,preferences:snapshot()}});await f.sync.load();
  const other=new PreferencesStore({storage:f.storage,profileId:'account-b'});
  await assert.rejects(f.sync.applyRemote(other,{consent:true}),e=>e.code==='PREFERENCE_PROFILE_MISMATCH');
  f.storage.blocked=true;const before=f.local.snapshot();
  await assert.rejects(f.sync.applyRemote(f.local,{consent:true}));
  assert.deepEqual(f.local.snapshot(),before);assert.equal(other.snapshot().themeId,'light');
});

test('explicit preference sync preserves system choice and a reviewed manual snapshot can turn it off',async()=>{
 const f=fixture({remote:{revision:1,preferences:snapshot({followSystem:true})}});
 await f.sync.load();assert.equal(f.local.snapshot().followSystem,undefined);
 await f.sync.applyRemote(f.local,{consent:true});assert.equal(f.local.snapshot().followSystem,true);
 await f.sync.save(f.local.snapshot(),{consent:true});assert.equal(f.state.preferences.followSystem,true);
 f.setState({revision:3,preferences:snapshot()});await f.sync.load();await f.sync.applyRemote(f.local,{consent:true});assert.equal(f.local.snapshot().followSystem,undefined);assert.equal(f.local.snapshot().themeId,'ocean');
});

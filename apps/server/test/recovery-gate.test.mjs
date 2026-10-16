import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';
import worker from '../../worker/worker.js';

const schema=await readFile(new URL('../../../packages/backup/schema/backup.sqlite.sql',import.meta.url),'utf8');
function restoreFence(database){
  database.exec(schema);
  database.prepare("INSERT INTO yumunio_recovery_state VALUES(1,?,?,?,?,?,'restoring',0,1,?)").run('fixture-restore','a'.repeat(64),'b'.repeat(64),'','2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z');
}
test('Node blocks every API during partial recovery even when backups and accounts are disabled',async t=>{
  const store=new SqliteSnapshotStore(':memory:'),server=createAppServer({snapshotStore:store,allowAnonymous:true});
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(origin+'/api/instance')).status,200);
  restoreFence(store.database);
  for(const path of ['/api/instance','/api/auth/config','/api/admin/users','/api/preferences','/api/collaboration/accept','/api/content/workspaces/fixture/pages','/api/public/pages/fixture','/api/workspace/snapshot']){
    const response=await fetch(origin+path);assert.equal(response.status,503,path);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{error:{code:'RECOVERY_IN_PROGRESS'}});
  }
  assert.equal((await fetch(origin+'/health')).status,503);
  store.database.exec("UPDATE yumunio_recovery_state SET status='ready',row_cursor=row_count");
  assert.equal((await fetch(origin+'/api/instance')).status,200);
  assert.equal((await fetch(origin+'/health')).status,200);
  store.database.exec("UPDATE yumunio_recovery_state SET plan_digest='corrupt'");
  assert.deepEqual(await(await fetch(origin+'/api/instance')).json(),{error:{code:'RECOVERY_UNAVAILABLE'}});
});
test('Worker API and scheduled jobs fail closed on partial or corrupt recovery state',async t=>{
  const store=new SqliteSnapshotStore(':memory:');t.after(()=>store.close());
  const database=store.database;
  const env={DB:{prepare(sql){return{bind(...params){return{async all(){return{success:true,results:database.prepare(sql).all(...params),meta:{}};}};}};},batch(){throw new Error('No writes are allowed by the gate.');}},
    YUMUNIO_PUBLIC_ORIGIN:'https://recovery.example.invalid',YUMUNIO_ACCESS_KEY:'recovery-gate-fixture-'.repeat(3),ASSETS:{fetch:()=>new Response('static')}};
  const request=path=>worker.fetch(new Request(env.YUMUNIO_PUBLIC_ORIGIN+path),env);
  assert.equal((await request('/api/instance')).status,200);
  restoreFence(database);
  for(const path of ['/api/instance','/api/auth/config','/api/workspace/snapshot','/api/public/pages/fixture']){
    const response=await request(path);assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'RECOVERY_IN_PROGRESS'}});
  }
  assert.equal((await request('/health')).status,503);assert.equal(await(await request('/app.js')).text(),'static');
  await assert.rejects(worker.scheduled({},env),{code:'RECOVERY_IN_PROGRESS'});
  database.exec("UPDATE yumunio_recovery_state SET status='ready',row_cursor=row_count");
  assert.equal((await request('/api/instance')).status,200);
  database.exec("UPDATE yumunio_recovery_state SET manifest_digest='corrupt'");
  assert.deepEqual(await(await request('/api/instance')).json(),{error:{code:'RECOVERY_UNAVAILABLE'}});
  await assert.rejects(worker.scheduled({},env));
});

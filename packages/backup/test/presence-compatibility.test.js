import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createD1RecoveryStore} from '../src/d1.js';
import {prepareRecoverySnapshot,TABLE_BY_NAME} from '../src/model.js';
import {database,d1,seed,seedPresence,stamp} from './fixtures.js';
const code=error=>error?.code==='RECOVERY_TARGET_NOT_EMPTY';
for(const dialect of ['sqlite','d1']){
 const store=db=>dialect==='sqlite'?createSqliteRecoveryStore(db):createD1RecoveryStore(d1(db));
 const planFor=async t=>{const db=database(t);await seed(db,{blobs:false});seedPresence(db);const snapshot=await store(db).capture({now:stamp});assert.ok(snapshot.excludedTables.includes('yumunio_room_presence'));assert.equal(TABLE_BY_NAME.has('yumunio_room_presence'),false);assert.equal(snapshot.tables.some(table=>table.name==='yumunio_room_presence'),false);assert.equal(JSON.stringify(snapshot).includes('ephemeral-session'),false);return prepareRecoverySnapshot(snapshot,{objectMapping:new Map(),now:stamp});};
 const options={restoreId:'presence-target-'+dialect,manifestDigest:'a'.repeat(64),preparedAt:stamp};
 test(dialect+' restores into an empty current presence schema without archiving ephemeral rows',async t=>{
  const plan=await planFor(t),db=database(t),target=store(db);let state=await target.beginRestore(plan,options);while(state.cursor<state.rowCount)state=await target.applyRestoreBatch(plan,options);assert.equal((await target.finishRestore(plan,options)).status,'ready');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_room_presence').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,1);
 });
 test(dialect+' rejects occupied presence and unknown empty tables without touching target rows or creating a restore fence',async t=>{
  const plan=await planFor(t);for(const occupied of [true,false]){const db=database(t);if(occupied)seedPresence(db);else db.exec('CREATE TABLE unknown_empty_extension(value TEXT)');const before=db.prepare('SELECT * FROM yumunio_room_presence').all(),target=store(db);await assert.rejects(target.beginRestore(plan,options),code);assert.deepEqual(db.prepare('SELECT * FROM yumunio_room_presence').all(),before);assert.equal(await target.getRecoveryState(),null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);}
 });
 test(dialect+' includes a presence row committed after metadata in the same atomic restore emptiness guard',async t=>{
  const plan=await planFor(t),db=database(t);let inserted=false,target;
  if(dialect==='sqlite')target=createSqliteRecoveryStore({prepare:sql=>db.prepare(sql),exec(sql){if(sql==='BEGIN IMMEDIATE'&&!inserted){inserted=true;seedPresence(db);}return db.exec(sql);}});
  else {const binding=d1(db);target=createD1RecoveryStore({...binding,async batch(commands){assert.match(commands[0].sql,/SELECT COUNT\(\*\) FROM "yumunio_room_presence"/);if(!inserted){inserted=true;seedPresence(db);}return binding.batch(commands);}});}
  await assert.rejects(target.beginRestore(plan,options),code);assert.equal(inserted,true);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_room_presence').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM yumunio_backup_guards').get().n,0);assert.equal(await target.getRecoveryState(),null);
 });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteContentStore} from '@yumunio/identity/content-store';
import {validateContentPayload} from '@yumunio/identity/content';
import {accountContentPolicy} from '../../identity/src/content-policy.js';
import {createPageAccessEvaluator} from '@yumunio/domain';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createRecoveryArchive,readRecoveryArchive} from '../src/archive.js';
import {restoreRecoveryArchive} from '../src/restore.js';
import {database,seed,memoryBlobs,stamp,secret} from './fixtures.js';
test('old archives and teamspace archives restore without schema changes, ACL expansion or lost immutable document metadata',async t=>{
 for(const withTeams of [false,true]){
  const db=database(t),{payload}=await seed(db,{blobs:false});
  if(withTeams){payload.teamspaces=[{id:'team',workspaceId:'workspace',name:'Synthetic private team',description:'Preserve',visibility:'private',defaultPermission:'editor',createdAt:stamp,updatedAt:stamp,archivedAt:null}];payload.teamspaceMembers=[{id:'team-member',workspaceId:'workspace',teamspaceId:'team',accountId:'account',membershipId:'membership-generation-a',role:'owner'}];payload.teamspacePages=[{workspaceId:'workspace',pageId:'page',teamspaceId:'team'}];payload.personalPageOwners=[];payload.pages[0].document.blocks.push({id:'raw-reference',type:'code',data:{text:'',purpose:'import-source',source:{raw_cells:{value:['unchanged',null,0,false]}}}});validateContentPayload(payload,'workspace');db.prepare('UPDATE yumunio_account_content SET payload_json=?').run(JSON.stringify(payload));}
  const snapshot=await createSqliteRecoveryStore(db).capture({now:stamp}),destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32)),archive=await createRecoveryArchive({snapshot,destination,key,authSecret:secret,createdAt:stamp});
  const decoded=await readRecoveryArchive({source:destination,key,backupId:archive.backupId,authSecret:secret});assert.equal(decoded.snapshot.schemaVersion,1);
  const target=database(t);await restoreRecoveryArchive({source:destination,key,backupId:archive.backupId,authSecret:secret,target:createSqliteRecoveryStore(target),restoreId:'teamspace-recovery',preparedAt:stamp});
  const saved=await createSqliteContentStore(target).read('workspace','account');assert.deepEqual(saved.payload.grants,payload.grants);assert.deepEqual(saved.payload.grantBindings,payload.grantBindings);assert.deepEqual(saved.payload.pages[0].document.blocks,payload.pages[0].document.blocks);
  if(withTeams){for(const name of ['teamspaces','teamspaceMembers','teamspacePages','personalPageOwners'])assert.deepEqual(saved.payload[name],payload[name]);assert.ok(createPageAccessEvaluator(accountContentPolicy(saved.payload,saved.principals,'workspace'))({accountId:'account',workspaceId:'workspace',pageId:'page'}).capabilities.includes('manage'));}else assert.equal(Object.hasOwn(saved.payload,'teamspaces'),false);
  assert.equal(target.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions').get().n,0);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createSqliteContentStore} from '@yumunio/identity/content-store';
import {validateContentPayload} from '@yumunio/identity/content';
import {createSqliteRecoveryStore} from '../src/sqlite.js';
import {createRecoveryArchive,readRecoveryArchive} from '../src/archive.js';
import {restoreRecoveryArchive} from '../src/restore.js';
import {database,seed,memoryBlobs,stamp,secret} from './fixtures.js';
test('recovery archives retain pending request generation metadata without inventing arrays in old archives',async t=>{
 for(const requests of [false,true]){const db=database(t),{payload}=await seed(db,{blobs:false});
  if(requests){payload.teamspaces=[{id:'closed-team',workspaceId:'workspace',name:'Synthetic closed team',description:'',visibility:'closed',defaultPermission:'viewer',createdAt:stamp,updatedAt:stamp,archivedAt:null}];payload.teamspaceJoinRequests=[{id:'pending-request',workspaceId:'workspace',teamspaceId:'closed-team',accountId:'account',membershipId:'old-membership-generation',createdAt:stamp}];validateContentPayload(payload,'workspace');db.prepare('UPDATE yumunio_account_content SET payload_json=?').run(JSON.stringify(payload));}
  const snapshot=await createSqliteRecoveryStore(db).capture({now:stamp}),destination=await memoryBlobs(),key=crypto.getRandomValues(new Uint8Array(32)),archive=await createRecoveryArchive({snapshot,destination,key,authSecret:secret,createdAt:stamp});const decoded=await readRecoveryArchive({source:destination,key,backupId:archive.backupId,authSecret:secret});assert.equal(decoded.snapshot.schemaVersion,1);
  const target=database(t);await restoreRecoveryArchive({source:destination,key,backupId:archive.backupId,authSecret:secret,target:createSqliteRecoveryStore(target),restoreId:'request-recovery',preparedAt:stamp});const saved=await createSqliteContentStore(target).read('workspace','account');assert.deepEqual(saved.payload.grants,payload.grants);assert.deepEqual(saved.payload.grantBindings,payload.grantBindings);for(const original of payload.pages){const restored=saved.payload.pages.find(item=>item.page.id===original.page.id);assert.deepEqual(restored.page,original.page);assert.deepEqual(restored.document.blocks,original.document.blocks);assert.equal(restored.document.version,original.document.version+1);}
  if(requests){assert.deepEqual(saved.payload.teamspaceJoinRequests,payload.teamspaceJoinRequests);assert.equal(saved.payload.teamspaceJoinRequests[0].membershipId,'old-membership-generation');assert.equal((saved.payload.teamspaceMembers??[]).length,0);}else assert.equal(Object.hasOwn(saved.payload,'teamspaceJoinRequests'),false);
 }
});

import assert from 'node:assert/strict';

/** Same concrete metadata/permission/lifecycle scenario against production Node and actual workerd/D1. */
export async function exerciseWebhookLifecycle({request,owner,admin,workspaceId,drain,restart,replaceMembership,received,setRetry,readPending,forceDue}){
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.json();};
 const base='/api/content/workspaces/'+workspaceId;let revision=(await ok(await request(base+'/pages',{account:owner}))).revision;
 const change=async(path,body,{method='POST',status=200}={})=>{const value=await ok(await request(base+path,{account:owner,method,body:{expectedRevision:revision,...body}}),status);assert.equal(value.revision,revision+1);revision=value.revision;return value;};
 const create=async(title,parentId=null)=>(await change('/pages',{title,parentId,blocks:[{id:'literal-body',type:'paragraph',data:{text:'Private synthetic body fixture@example.invalid'}}]},{status:201})).page;
 const root=await create('Private root'),outside=await create('Private outside'),hook='/api/webhooks/workspaces/'+workspaceId+'/pages/'+root.id;
 const config=await ok(await request('/api/webhooks/config',{account:owner}));assert.equal(config.profile.includeDescendants,true);assert.deepEqual(config.eventTypes,['page.updated','page.title.updated','page.document.updated','page.created','page.moved','page.trashed','page.restored']);
 const approval={expectedVersion:0,profileDigest:config.profile.profileDigest,eventTypes:config.eventTypes,confirmMetadataTransfer:true};
 assert.equal((await request('/api/webhooks/approval',{account:owner,method:'POST',body:approval})).status,404);await ok(await request('/api/webhooks/approval',{account:admin,method:'POST',body:approval}));
 const consent={expectedRevision:revision,expectedVersion:0,profileDigest:config.profile.profileDigest,confirmMetadataTransfer:true,acknowledgeMissing:false};
 assert.equal((await request(hook+'/subscription',{account:owner,method:'POST',body:consent})).status,400);
 const body={...consent,confirmDescendants:true};
 for(const [headers,status]of [[{'X-Yumunio-Expected-Account':admin.id},404],[{Origin:'https://foreign.lifecycle.invalid'},403]])assert.equal((await request(hook+'/subscription',{account:owner,method:'POST',body,headers})).status,status);
 await ok(await request(hook+'/subscription',{account:owner,method:'POST',body}));
 const a=await create('Private child A',root.id),b=await create('Private child B',root.id);await drain();
 assert.equal(received.length,2);assert.deepEqual(new Set(received.map(event=>event.pageId)),new Set([a.id,b.id]));assert.ok(received.every(event=>event.eventType==='page.created'&&event.version===1));
 await restart();assert.equal((await ok(await request(hook+'/deliveries',{account:owner}))).deliveries.filter(row=>row.status==='delivered').length,2);
 await change('/pages/'+a.id+'/location',{parentId:b.id,inheritPermissions:true},{method:'PATCH'});await drain();assert.equal(received.at(-1).eventType,'page.moved');assert.equal(received.at(-1).pageId,a.id);
 await change('/pages/'+root.id+'/location',{parentId:outside.id,inheritPermissions:false},{method:'PATCH'});await drain();assert.equal(received.at(-1).eventType,'page.moved');assert.equal(received.at(-1).pageId,root.id);assert.equal((await ok(await request(hook+'/subscription',{account:owner}))).subscription.status,'active');
 let count=received.length;await change('/pages/'+root.id,{}, {method:'DELETE'});await drain();assert.equal(received.length,count+3);assert.ok(received.slice(count).every(event=>event.eventType==='page.trashed'));assert.equal((await request(base+'/pages/'+root.id,{account:owner})).status,404);
 count=received.length;await change('/pages/'+root.id+'/restore',{parentId:outside.id,inheritPermissions:false});await drain();assert.equal(received.length,count+3);assert.ok(received.slice(count).every(event=>event.eventType==='page.restored'));
 await restart();const restored=await ok(await request(base+'/pages/'+root.id,{account:owner}));assert.equal(restored.document.blocks[0].data.text,'Private synthetic body fixture@example.invalid');assert.equal(restored.page.parentId,outside.id);
 const deliveries=await ok(await request(hook+'/deliveries',{account:owner}));assert.equal(deliveries.deliveries.filter(row=>row.status==='delivered').length,received.length);assert.ok(deliveries.deliveries.every(row=>!Object.hasOwn(row,'payloadJson')));assert.equal(new Set(received.map(event=>event.eventId)).size,received.length);
 setRetry(true);const pendingPage=await create('Private pending child',root.id);await drain();let pending;const deadline=performance.now()+8000;
 do{pending=await readPending(pendingPage.id);if(pending?.status==='queued'&&pending.attempts>=1)break;await new Promise(resolve=>setTimeout(resolve,20));}while(performance.now()<deadline);
 assert.equal(pending?.status,'queued');assert.ok(pending.attempts>=1);const beforeGeneration=received.length;
 await replaceMembership(owner.id);await forceDue();setRetry(false);await drain();assert.equal(received.length,beforeGeneration);assert.equal((await request(hook+'/subscription',{account:owner})).status,404);
}

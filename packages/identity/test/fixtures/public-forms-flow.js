import assert from 'node:assert/strict';

/** A real HTTP attempt may cross a minute/hour boundary; verify the persisted window, not wall-clock luck. */
export function assertChargedPublicFormRate(before,after,{startedAt,finishedAt}){
 assert.ok(Number.isSafeInteger(startedAt)&&Number.isSafeInteger(finishedAt)&&finishedAt>=startedAt);
 assert.ok(after);if(before)assert.equal(after.formId,before.formId);
 for(const[window,duration]of[['minute',60000],['hour',3600000]]){
  const start=after[window+'Start'],count=after[window+'Count'];assert.ok(Number.isSafeInteger(start)&&start>=0&&start%duration===0);assert.ok(Number.isSafeInteger(count)&&count>0);
  assert.ok(start>=Math.floor(startedAt/duration)*duration&&start<=Math.floor(finishedAt/duration)*duration,window+' window must contain the charged request');
  if(before)assert.ok(start>=before[window+'Start'],window+' window must not move backwards');
  assert.equal(count,before&&start===before[window+'Start']?before[window+'Count']+1:1,window+' counter must charge exactly once');
 }
 assert.ok(after.minuteCount<=after.hourCount);
}

/** Real-cookie management, anonymous requests and durable storage: shared Node/D1 acceptance contract. */
export async function exercisePublicForms({request,owner,member,workspaceId,inspect,restart,replacePublisherMembership}){
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();},error=async(response,status,code)=>{assert.equal(response.status,status,await response.clone().text());assert.equal((await response.json()).error.code,code);};
 const base='/api/content/workspaces/'+workspaceId,collection=await ok(await request(base+'/collections',{method:'POST',account:owner,body:{expectedRevision:0,title:'Private anonymous responses',parentId:null,properties:[{id:'rating',name:'Internal rating column',type:'number',required:true}]}}),201),forms=base+'/collections/'+collection.collectionId+'/forms';
 const created=await ok(await request(forms,{method:'POST',account:owner,body:{expectedRevision:1,definition:{title:'Public feedback',description:'Anyone with the link may respond',fields:[{id:'public-rating',propertyId:'rating',label:'Your rating',description:'Public question',required:true,condition:null}]}}}),201),manage=forms+'/'+created.formId;
 const publish=async revision=>{await ok(await request(manage+'/acceptance',{method:'POST',account:owner,body:{expectedRevision:revision,accepting:true,audience:'anonymous',confirmManagerAccess:true,confirmPublicExposure:true}}));const dto=(await ok(await request(manage,{account:owner}))).form;assert.equal(dto.audience,'anonymous');assert.equal(dto.accepting,true);const token=new URL(dto.publicPath,'https://fixture.invalid').searchParams.get('public');assert.match(token,/^[a-f0-9]{160,2048}$/);return'/api/public/forms/'+token;};
 const path=await publish(2),form=await ok(await request(path));assert.equal(form.id,'public-form');assert.equal(form.accountRequired,false);assert.equal(form.accessToSubmission,'none');assert.equal(form.fields[0].type,'number');
 for(const value of [workspaceId,owner.id,member.id,collection.collectionId,collection.pageId,created.formId,'Internal rating column'])assert.equal(JSON.stringify(form).includes(value),false);
 const rate=saved=>saved.payload.formRateCounters?.find(row=>row.formId===created.formId),charge=async run=>{const before=rate(await inspect()),startedAt=Date.now();await run();const finishedAt=Date.now(),after=rate(await inspect());assertChargedPublicFormRate(before,after,{startedAt,finishedAt});return after;};
 const body={requestId:crypto.randomUUID(),version:1,answers:{'public-rating':0}};await charge(async()=>{const responses=await Promise.all([request(path+'/responses',{method:'POST',body}),request(path+'/responses',{method:'POST',body})]);assert.deepEqual(responses.map(response=>response.status).sort(),[200,201]);for(const response of responses)assert.deepEqual(await response.json(),{requestId:body.requestId,accepted:true});});
 await charge(async()=>error(await request(path+'/responses',{method:'POST',body:{...body,requestId:crypto.randomUUID(),answers:{}}}),400,'FORM_REQUIRED_ANSWER'));
 const firstRate=await charge(async()=>error(await request(path+'/responses',{method:'POST',body:{...body,requestId:crypto.randomUUID(),answers:{'public-rating':'0'}}}),400,'INVALID_FORM'));
 let saved=await inspect();assert.equal(saved.revision,6);assert.equal(saved.payload.publicFormReceipts.length,1);assert.equal(saved.payload.collections[0].collection.records.length,1);const pageId=saved.payload.publicFormReceipts[0].pageId;
 assert.equal(saved.payload.pages.find(row=>row.page.id===pageId).inheritPermissions,false);assert.deepEqual(saved.payload.grants.filter(row=>row.pageId===pageId).map(row=>row.accountId),[owner.id]);
 await error(await request(base+'/pages/'+pageId),401,'UNAUTHORIZED');await error(await request(base+'/pages/'+pageId,{account:member}),404,'CONTENT_NOT_FOUND');
 await restart();assert.deepEqual(await ok(await request(path+'/responses',{method:'POST',body})),{requestId:body.requestId,accepted:true});saved=await inspect();assert.equal(saved.revision,6);assert.deepEqual(rate(saved),firstRate);
 const source=await ok(await request(base+'/pages/'+pageId,{account:owner}));assert.deepEqual(JSON.parse(source.document.blocks[0].data.text).questions,[{label:'Your rating',value:0}]);
 const next=await publish(6);assert.notEqual(next,path);await error(await request(path),404,'PUBLIC_FORM_NOT_FOUND');await error(await request(path+'/responses',{method:'POST',body}),404,'PUBLIC_FORM_NOT_FOUND');
 const second={requestId:crypto.randomUUID(),version:2,answers:{'public-rating':9}},finalRate=await charge(async()=>ok(await request(next+'/responses',{method:'POST',body:second}),201));await ok(await request(manage+'/acceptance',{method:'POST',account:owner,body:{expectedRevision:8,accepting:false}}));await error(await request(next),404,'PUBLIC_FORM_NOT_FOUND');await error(await request(next+'/responses',{method:'POST',body:second}),404,'PUBLIC_FORM_NOT_FOUND');
 const final=await publish(9);await replacePublisherMembership();await error(await request(final),404,'PUBLIC_FORM_NOT_FOUND');await error(await request(final+'/responses',{method:'POST',body:{...second,version:3}}),404,'PUBLIC_FORM_NOT_FOUND');saved=await inspect();assert.equal(saved.revision,10);assert.equal(saved.payload.publicFormReceipts.length,2);assert.deepEqual(rate(saved),finalRate);
}

import assert from 'node:assert/strict';
const deadline=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Content change was not pushed.')),10000);})]);}finally{clearTimeout(timer);}};

/** Cross-account, committed body/DB/ACL changes. Nothing here polls for events. */
export async function exerciseContentStream({origin,request,owner,member,workspaceId,Socket,denyUpgrade}){
 const base='/api/content/workspaces/'+workspaceId,peers=[];
 const ok=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
 const open=account=>{
  const socket=new(Socket(account))(origin.replace(/^http/,'ws')+base+'/changes/ws'),messages=[],waiters=[];
  const peer={socket,messages,closed:null,wait(type,after=0){const found=messages.slice(after).find(message=>message.type===type);if(found)return Promise.resolve(found);return deadline(new Promise(resolve=>waiters.push({type,after,resolve})));}};
  socket.addEventListener('message',event=>{const value=JSON.parse(event.data);assert.ok(['ready','changed','pong','denied'].includes(value.type));assert.deepEqual(Object.keys(value),['type']);messages.push(value);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(value.type===waiter.type&&messages.length>waiter.after){waiters.splice(index,1);waiter.resolve(value);}}if(value.type==='denied')try{socket.close(4003);}catch{}});
  peer.closed=new Promise(resolve=>socket.addEventListener('close',event=>resolve(event.code),{once:true}));peers.push(peer);return peer;
 };
 let stage='handshake';
 try{
  await denyUpgrade(base+'/changes/ws',null,origin,401);
  await denyUpgrade(base+'/changes/ws',member,'https://different.fixture.invalid',403);
  const left=open(owner),right=open(member);await Promise.all([left.wait('ready'),right.wait('ready')]);
  const initial=await ok(await request(base+'/changes',{account:owner}));assert.ok(Number.isSafeInteger(initial.revision));assert.equal(initial.accountId,owner.id);
  let revision=initial.revision,at=right.messages.length;
  stage='private creation';
  const page=await ok(await request(base+'/pages',{account:owner,method:'POST',body:{expectedRevision:revision,title:'Pushed private page',blocks:[{id:'live-text',type:'paragraph',data:{text:'first'}}]}}),201);revision=page.revision;
  await right.wait('changed',at);assert.equal((await request(base+'/pages/'+page.page.id+'?context=1',{account:member})).status,404);
  stage='grant';at=right.messages.length;
  revision=(await ok(await request(base+'/pages/'+page.page.id+'/grants',{account:owner,method:'POST',body:{expectedRevision:revision,accountId:member.id,permission:'editor'}}))).revision;
  await right.wait('changed',at);
  stage='body';at=right.messages.length;
  revision=(await ok(await request(base+'/pages/'+page.page.id,{account:owner,method:'PATCH',body:{expectedRevision:revision,expectedVersion:1,title:'Pushed title',blocks:[{id:'live-text',type:'paragraph',data:{text:'saved in another session'}}]}}))).revision;
  await right.wait('changed',at);
  const context=await ok(await request(base+'/pages/'+page.page.id+'?context=1&directory=1',{account:member}));assert.equal(context.page.title,'Pushed title');assert.equal(context.document.blocks[0].data.text,'saved in another session');assert.equal(context.context.accountId,member.id);assert.equal(context.context.directory.revision,context.revision);assert.ok(Array.isArray(context.context.directory.teamspaces));
  stage='database';at=right.messages.length;
  const created=await ok(await request(base+'/collections',{account:owner,method:'POST',body:{expectedRevision:revision,title:'Pushed tasks',parentId:null,properties:[{id:'status',name:'Status',type:'status',options:['Todo','Done']},{id:'person',name:'Person',type:'person'}]}}),201);revision=created.revision;
  await right.wait('changed',at);revision=(await ok(await request(base+'/pages/'+created.pageId+'/grants',{account:owner,method:'POST',body:{expectedRevision:revision,accountId:member.id,permission:'editor',includeDescendants:true}}))).revision;
  const path=base+'/collections/'+created.collectionId;
  const row=await ok(await request(path+'/records',{account:owner,method:'POST',body:{expectedRevision:revision,title:'Pushed record',values:{status:'Todo',person:member.id}}}),201);revision=row.revision;
  // Records have an explicit grant if the source grant did not inherit.
  if((await request(base+'/pages/'+row.record.pageId,{account:member})).status===404)revision=(await ok(await request(base+'/pages/'+row.record.pageId+'/grants',{account:owner,method:'POST',body:{expectedRevision:revision,accountId:member.id,permission:'editor'}}))).revision;
  at=right.messages.length;
  revision=(await ok(await request(path+'/records/'+row.record.id,{account:owner,method:'PATCH',body:{expectedRevision:revision,values:{status:'Done'}}}))).revision;await right.wait('changed',at);
  const record=await ok(await request(base+'/pages/'+row.record.pageId+'?context=1',{account:member}));assert.equal(record.context.collection.revision,record.revision);assert.equal(record.context.collection.collection.records[0].values.status,'Done');assert.ok(record.context.people.some(person=>person.accountId===member.id));
  stage='reconnect';right.socket.close();await deadline(right.closed);
  revision=(await ok(await request(base+'/pages/'+page.page.id,{account:owner,method:'PATCH',body:{expectedRevision:revision,expectedVersion:2,title:'Missed while disconnected'}}))).revision;
  const resumed=open(member);await resumed.wait('ready');assert.equal((await ok(await request(base+'/pages/'+page.page.id+'?context=1',{account:member}))).page.title,'Missed while disconnected');
  stage='page revocation';at=resumed.messages.length;
  revision=(await ok(await request(base+'/pages/'+created.pageId+'/grants',{account:owner,method:'POST',body:{expectedRevision:revision,accountId:member.id,permission:'deny'}}))).revision;await resumed.wait('changed',at);
  const hidden=await request(base+'/pages/'+row.record.pageId+'?context=1',{account:member});if(hidden.status===200){const value=await hidden.json();assert.equal(value.context.collection,null);assert.deepEqual(value.context.people,[]);}else assert.equal(hidden.status,404);
  stage='membership revocation';
  const members=await ok(await request('/api/collaboration/workspaces/'+workspaceId+'/members',{account:owner})),target=members.members.find(person=>person.accountId===member.id);
  at=resumed.messages.length;await ok(await request('/api/collaboration/workspaces/'+workspaceId+'/members/'+target.id,{account:owner,method:'DELETE',body:{expectedRevision:members.revision}}));await resumed.wait('denied',at);
  assert.equal((await request(base+'/changes',{account:member})).status,404);
 }catch(error){error.message=stage+': '+error.message;throw error;}
 finally{for(const peer of peers)try{peer.socket.close();}catch{}}
}

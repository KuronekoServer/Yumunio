import test from 'node:test';
import assert from 'node:assert/strict';
import {TeamspaceClient,validateTeamspaceRequests,validateTeamspaceRequestAck} from '../public/teamspace-client.js';
const stamp='2026-10-16T00:00:00.000Z',row={id:'request-b',accountId:'account-b',name:'Beni',createdAt:stamp,currentUser:false};
const queue={workspaceId:'studio',revision:4,teamspaceId:'team',canReview:true,canRequest:false,requests:[row],myRequest:null};
const intent={workspaceId:'studio',teamspaceId:'team',expectedRevision:4,requestId:'request-b',accountId:'account-b',action:'approve'};
const ack={workspaceId:'studio',revision:5,teamspaceId:'team',requestId:'request-b',accountId:'account-b',action:'approve'};
const session={user:{id:'account-a',emailVerified:true}};
test('join-request projections enforce bounded private rows and omit generation identifiers',()=>{
 assert.deepEqual(validateTeamspaceRequests(queue,'studio','team'),queue);
 for(const value of [{...queue,canReview:false},{...queue,myRequest:row},{...queue,requests:[row,row]},{...queue,requests:[{...row,membershipId:'private'}]},{...queue,requests:[{...row,createdAt:'2026-10-16'}]},{...queue,teamspaceId:'other'},{...queue,revision:-1},{...queue,extra:true}])assert.throws(()=>validateTeamspaceRequests(value,'studio','team'));
 const own={...queue,canReview:false,requests:[],myRequest:{...row,accountId:'account-a',currentUser:true}};assert.deepEqual(validateTeamspaceRequests(own,'studio','team'),own);assert.throws(()=>validateTeamspaceRequests({...own,canRequest:true},'studio','team'));
});
test('request ACK binds exact subject, action, request identity and one next revision',()=>{
 assert.deepEqual(validateTeamspaceRequestAck(ack,intent),ack);
 for(const patch of [{requestId:'another'},{accountId:'account-c'},{action:'reject'},{revision:4},{revision:6},{workspaceId:'other'},{teamspaceId:'other'},{membershipId:'private'}])assert.throws(()=>validateTeamspaceRequestAck({...ack,...patch},intent));
});
test('request methods capture consent and bind session/Origin/subject; malformed success fences replay',async()=>{
 const calls=[];let response=ack;const client=new TeamspaceClient({workspaceId:'studio',accountId:'account-a',fetcher:async(path,init)=>{calls.push({path,init});return Response.json(path.endsWith('get-session')?session:response);}});
 const body={expectedRevision:4,requestId:'request-b',accountId:'account-b',decision:'approve',confirmAccessChange:true},pending=client.decideRequest('team',body);body.decision='reject';assert.deepEqual(await pending,ack);const sent=calls.find(call=>call.init.method==='PATCH');assert.deepEqual(JSON.parse(sent.init.body),{expectedRevision:4,requestId:'request-b',accountId:'account-b',decision:'approve',confirmAccessChange:true});assert.equal(sent.init.headers['X-Yumunio-Expected-Account'],'account-a');assert.equal(sent.init.credentials,'same-origin');assert.ok(sent.path.endsWith('/teamspaces/team/requests'));
 response={...ack,requestId:'wrong'};await assert.rejects(client.decideRequest('team',{expectedRevision:4,requestId:'request-b',accountId:'account-b',decision:'approve',confirmAccessChange:true}),error=>error.code==='INVALID_RESPONSE');assert.equal(client.uncertain,true);const writes=calls.filter(call=>call.init.method==='PATCH').length;await assert.rejects(client.decideRequest('team',{expectedRevision:4,requestId:'request-b',accountId:'account-b',decision:'approve',confirmAccessChange:true}),error=>error.code==='REQUEST_UNCONFIRMED');assert.equal(calls.filter(call=>call.init.method==='PATCH').length,writes);client.destroy();
});
test('request/cancel bind the captured actor and reject missing confirmations before a write',async()=>{
 const calls=[];let result={...ack,requestId:'fresh-request',accountId:'account-a',action:'request'};const client=new TeamspaceClient({workspaceId:'studio',accountId:'account-a',fetcher:async(path,init)=>{calls.push({path,init});return Response.json(path.endsWith('get-session')?session:result);}});
 await assert.rejects(client.requestJoin('team',{expectedRevision:4,confirmRequest:false}));assert.equal(calls.length,0);assert.equal((await client.requestJoin('team',{expectedRevision:4,confirmRequest:true})).action,'request');result={...result,revision:6,action:'cancel'};assert.equal((await client.cancelRequest('team',{expectedRevision:5,requestId:'fresh-request',confirmCancel:true})).action,'cancel');assert.deepEqual(calls.filter(call=>!call.path.endsWith('get-session')).map(call=>call.init.method),['POST','DELETE']);client.destroy();
});
test('an account switch after a request write is unknown and cannot continue under the old actor',async()=>{
 let sessions=0,writes=0;const client=new TeamspaceClient({workspaceId:'studio',accountId:'account-a',fetcher:async(path)=>{if(path.endsWith('get-session'))return Response.json(++sessions===1?session:{user:{id:'account-other',emailVerified:true}});writes++;return Response.json({...ack,accountId:'account-a',action:'request'});}});
 await assert.rejects(client.requestJoin('team',{expectedRevision:4,confirmRequest:true}),error=>error.code==='ACCOUNT_CHANGED');assert.equal(writes,1);assert.equal(client.uncertain,true);client.destroy();
});

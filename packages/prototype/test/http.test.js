import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceApi, validateSnapshot, SnapshotError, MAX_BODY_BYTES } from '../src/index.js';
import { createDemoWorkspace } from '../../../apps/web/public/store.js';

function fixture({ accessKey = '', now } = {}) {
  let revision = 0, snapshot = null;
  const store = {
    async read() { return { revision, snapshot }; },
    async write(expected, data) {
      if (expected !== revision) throw new SnapshotError('VERSION_CONFLICT', 'Conflict.', 409, { actualRevision: revision });
      snapshot = structuredClone(data); return { revision: ++revision, snapshot };
    }
  };
  const api = createWorkspaceApi({ store, storage: 'sqlite', allowAnonymous: !accessKey, accessKey, origin: 'https://localhost', ...(now ? { now } : {}) });
  const request = (path, method = 'GET', body, headers = {}) => new Request('https://localhost' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://localhost' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { api, request };
}

test('anonymous persistence cannot use a public origin', () => {
  assert.throws(() => createWorkspaceApi({ store: {}, allowAnonymous: true, origin: 'https://public.example' }));
});

test('prototype schema rejects malformed hierarchy and dates without changing input', () => {
  const original = createDemoWorkspace();
  assert.deepEqual(validateSnapshot(original), original);
  const cycle = structuredClone(original); cycle.pages[0].parentId = 'page-guide';
  assert.throws(() => validateSnapshot(cycle), { code: 'INVALID_SNAPSHOT' });
  const date = structuredClone(original); date.pages.find(page => page.kind === 'record').properties.date = '2026-02-30';
  assert.throws(() => validateSnapshot(date), { code: 'INVALID_SNAPSHOT' });
  const wrongCollection = structuredClone(original); wrongCollection.pages.find(page => page.kind === 'record').collectionId = 'page-spec';
  assert.throws(() => validateSnapshot(wrongCollection), { code: 'INVALID_SNAPSHOT' });
  const clone = validateSnapshot(original); clone.pages[0].title = 'changed';
  assert.notEqual(original.pages[0].title, clone.pages[0].title);
});

test('shared API uses same-origin CAS and leaves committed data on stale updates', async () => {
  const { api, request } = fixture();
  assert.deepEqual(await (await api(request('/api/workspace/snapshot'))).json(), { revision: 0, snapshot: null });
  const data = createDemoWorkspace();
  assert.equal((await api(request('/api/workspace/snapshot', 'PUT', { expectedRevision: 0, snapshot: data }))).status, 200);
  const conflict = await api(request('/api/workspace/snapshot', 'PUT', { expectedRevision: 0, snapshot: { ...data, name: 'lost update' } }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.details.actualRevision, 1);
  assert.equal((await (await api(request('/api/workspace/snapshot'))).json()).snapshot.name, data.name);
  assert.equal((await api(request('/api/workspace/snapshot', 'PUT', { expectedRevision: 1, snapshot: data }, { Origin: 'https://attacker.test' }))).status, 403);
  assert.equal((await api(request('/api/workspace/snapshot', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal((await api(new Request('https://attacker.test/api/workspace/snapshot'))).status, 403);
  assert.equal((await api(request('/api/workspace/snapshot', 'PUT', { expectedRevision: 1, snapshot: data }, { Origin: '' }))).status, 403);
});

test('prototype HTTP preserves canonical inline formatting and rejects unsafe links without changing the saved revision',async()=>{
  const {api,request}=fixture(),data=createDemoWorkspace(),page=data.pages.find(item=>item.kind==='document');
  page.blocks=[{id:'inline-fixture',type:'paragraph',text:'safe 😀 note',checked:false,marks:[{start:0,end:4,styles:['bold'],href:'https://example.invalid/guide'}]}];
  const saved=await api(request('/api/workspace/snapshot','PUT',{expectedRevision:0,snapshot:data}));assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).snapshot.pages.find(item=>item.id===page.id).blocks[0].marks,page.blocks[0].marks);
  for(const marks of [[{start:0,end:4,styles:['bold'],href:'javascript:alert(1)'}],[{start:6,end:7,styles:['bold']}],[{start:0,end:5,styles:['bold']},{start:4,end:8,styles:['italic']}],[{start:0,end:4,styles:['bold'],html:'<script>'}]]){
    const changed=structuredClone(data);changed.pages.find(item=>item.id===page.id).blocks[0].marks=marks;
    const response=await api(request('/api/workspace/snapshot','PUT',{expectedRevision:1,snapshot:changed}));assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_SNAPSHOT');
  }
  const read=await(await api(request('/api/workspace/snapshot'))).json();assert.equal(read.revision,1);assert.deepEqual(read.snapshot,data);
});

test('access-key sessions are signed, HttpOnly, expiring and cleared on logout', async () => {
  let time = Date.now(); const accessKey = 'fixture-' + 'A'.repeat(32);
  const { api, request } = fixture({ accessKey, now: () => time });
  assert.equal((await api(request('/api/workspace/snapshot'))).status, 401);
  assert.equal((await api(request('/api/session', 'POST', { accessKey: 'incorrect' }))).status, 401);
  const login = await api(request('/api/session', 'POST', { accessKey }));
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await api(request('/api/workspace/snapshot', 'GET', undefined, { Cookie: cookie }))).status, 200);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await api(request('/api/workspace/snapshot', 'GET', undefined, { Cookie: tampered }))).status, 401);
  const logout = await api(request('/api/session', 'DELETE', {}, { Cookie: cookie }));
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  time += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await api(request('/api/workspace/snapshot', 'GET', undefined, { Cookie: cookie }))).status, 401);
});

test('body and schema limits fail before persistence and raw storage errors stay private', async () => {
  const { api, request } = fixture();
  assert.equal((await api(new Request('https://localhost/api/workspace/snapshot', { method: 'PUT', headers: { Origin: 'https://localhost', 'Content-Type': 'text/plain' }, body: '{}' }))).status, 415);
  assert.equal((await api(request('/api/workspace/snapshot', 'PUT', { expectedRevision: 0, snapshot: {} }))).status, 400);
  const huge = 'x'.repeat(MAX_BODY_BYTES + 1);
  const tooLarge = await api(new Request('https://localhost/api/workspace/snapshot', { method: 'PUT', headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' }, body: huge }));
  assert.equal(tooLarge.status, 413);
  const failed = createWorkspaceApi({ store: { read() { throw new Error('SELECT private contents'); } }, allowAnonymous: true, origin: 'https://localhost' });
  const failure = await failed(request('/api/workspace/snapshot'));
  assert.equal(failure.status, 500);
  assert.ok(!(await failure.text()).includes('SELECT'));
  assert.deepEqual(await (await api(request('/api/workspace/snapshot'))).json(), { revision: 0, snapshot: null });
});

test('oversize remains 413 when stream cancellation fails', async () => {
  const { api } = fixture();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES + 1)); }, cancel() { throw new Error('Cancel failed'); } });
  const response = await api(new Request('https://localhost/api/workspace/snapshot', { method: 'PUT', headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' }, body: stream, duplex: 'half' }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
});

test('flat Markdown blocks persist through HTTP and invalid metadata never advances the saved revision',async()=>{
 const{api,request}=fixture(),data=createDemoWorkspace(),page=data.pages.find(item=>item.kind==='document');
 page.blocks=[
  {id:'http-heading3',type:'heading3',text:'Detail',checked:false},
  {id:'http-bullet',type:'bulleted-list',text:'Bullet',checked:false},
  {id:'http-ordered',type:'numbered-list',text:'Number',checked:false,start:37},
  {id:'http-quote',type:'quote',text:'Quote',checked:false},
  {id:'http-divider',type:'divider',text:'',checked:false},
  {id:'http-code',type:'code',text:'<literal>\n```',checked:false,language:'c++'}
 ];
 const saved=await api(request('/api/workspace/snapshot','PUT',{expectedRevision:0,snapshot:data}));assert.equal(saved.status,200);
 assert.deepEqual((await saved.json()).snapshot,data);
 for(const patch of [{start:0},{language:'js\n```'},{children:[]}]){
  const invalid=structuredClone(data);Object.assign(invalid.pages.find(item=>item.id===page.id).blocks[2],patch);
  const response=await api(request('/api/workspace/snapshot','PUT',{expectedRevision:1,snapshot:invalid}));assert.equal(response.status,400);
 }
 const read=await(await api(request('/api/workspace/snapshot'))).json();assert.equal(read.revision,1);assert.deepEqual(read.snapshot,data);
});

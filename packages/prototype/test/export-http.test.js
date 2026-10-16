import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceApi } from '../src/index.js';
import { createDemoWorkspace, parseWorkspaceJSON } from '../../../apps/web/public/store.js';
const origin = 'https://localhost';
function fixture(accessKey = '') {
  let revision = 0, snapshot = null, reads = 0, writes = 0;
  const store = {
    async read() { reads++; return { revision, snapshot }; },
    async write(expected, value) { assert.equal(expected, revision); writes++; snapshot = structuredClone(value); return { revision: ++revision, snapshot }; }
  };
  const api = createWorkspaceApi({ store, storage: 'sqlite', accessKey, allowAnonymous: !accessKey, origin, now: () => Date.parse('2026-10-15T03:00:00.000Z') });
  const request = (path, { method = 'GET', body, cookie, headers = {} } = {}) => new Request(origin + path, { method, headers: { ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { api, request, counts: () => ({ reads, writes }) };
}
test('exports reuse authentication, preserve committed revision and support Unicode download names', async () => {
  const accessKey = 'fixture-'.repeat(8), f = fixture(accessKey);
  assert.equal((await f.api(f.request('/api/workspace/export'))).status, 401);
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  const login = await f.api(f.request('/api/session', { method: 'POST', body: { accessKey } }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.api(f.request('/api/workspace/export', { cookie }))).status, 404);
  const snapshot = createDemoWorkspace(); snapshot.pages[0].deletedAt = '2026-10-15T02:00:00.000Z';
  assert.equal((await f.api(f.request('/api/workspace/snapshot', { method: 'PUT', cookie, body: { expectedRevision: 0, snapshot } }))).status, 200);
  const result = await f.api(f.request('/api/workspace/export?format=native-json', { cookie }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-yumunio-revision'), '1');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('content-disposition'), /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.ok(result.headers.get('content-disposition').includes('%'));
  const bytes = await result.arrayBuffer();
  assert.equal(result.headers.get('content-length'), String(bytes.byteLength));
  const exported = parseWorkspaceJSON(new TextDecoder().decode(bytes));
  assert.ok(!exported.pages.some(page => ['page-spec', 'page-guide'].includes(page.id)));
  const complete = await f.api(f.request('/api/workspace/export?format=native-json&includeTrash=true', { cookie }));
  assert.deepEqual(parseWorkspaceJSON(await complete.text()), snapshot);
  const zip = await f.api(f.request('/api/workspace/export?format=markdown-csv-zip', { cookie }));
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(new DataView(await zip.arrayBuffer()).getUint32(0, true), 0x04034b50);
  assert.equal(f.counts().writes, 1);
  for (const headers of [{ Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.api(f.request('/api/workspace/export', { cookie, headers }))).status, 403);
  assert.equal(f.counts().writes, 1);
});
test('unsupported and duplicate export parameters and methods do not access storage', async () => {
  const f = fixture();
  for (const query of ['?format=html', '?format=', '?includeTrash=', '?includeTrash=1', '?format=native-json&format=markdown-csv-zip', '?includeTrash=false&includeTrash=true', '?secret=value']) {
    const result = await f.api(f.request('/api/workspace/export' + query));
    assert.equal(result.status, 400, query);
    assert.equal((await result.json()).error.code, 'EXPORT_OPTIONS');
  }
  const result = await f.api(f.request('/api/workspace/export', { method: 'POST', body: {} }));
  assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'GET');
  assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
  assert.equal((await createWorkspaceApi({ origin })(f.request('/api/workspace/export'))).status, 501);
});

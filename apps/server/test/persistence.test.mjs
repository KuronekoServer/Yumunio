import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';
import { createDemoWorkspace } from '../../web/public/store.js';
import { MAX_BODY_BYTES } from '@yumunio/prototype';

test('real Node HTTP and SQLite persist snapshots, reject stale writes and block foreign origins', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'yumunio-snapshot-'));
  const filename = join(fixture, 'workspace.sqlite');
  let store = new SqliteSnapshotStore(filename);
  let server = createAppServer({ snapshotStore: store, allowAnonymous: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    const target = await realpath(fixture);
    assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.match(basename(target), /^yumunio-snapshot-/);
    await rm(target, { recursive: true, force: true });
  });
  let origin = 'http://127.0.0.1:' + server.address().port;
  const put = (snapshot, expectedRevision, extra = {}) => fetch(origin + '/api/workspace/snapshot', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ snapshot, expectedRevision }) });
  const data = createDemoWorkspace();
  assert.equal((await (await fetch(origin + '/api/capabilities')).json()).workspaceSync, true);
  assert.equal((await put(data, 0)).status, 200);
  const second = new SqliteSnapshotStore(filename);
  assert.deepEqual((await second.read()).snapshot, data);
  await assert.rejects(second.write(0, data), { code: 'VERSION_CONFLICT' });
  second.close();
  assert.equal((await put({ ...data, name: 'concurrent' }, 0)).status, 409);
  assert.equal((await put(data, 1, { Origin: 'https://attacker.test' })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => { const req = request(origin + '/api/workspace/snapshot', { headers: { Host: 'attacker.test' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); req.on('error', reject); req.end(); });
  assert.equal(rebindingStatus, 403);
  const huge = await fetch(origin + '/api/workspace/snapshot', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
  assert.equal(huge.status, 413);
  await new Promise(resolve => server.close(resolve)); store.close();
  store = new SqliteSnapshotStore(filename); server = createAppServer({ snapshotStore: store, allowAnonymous: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  const loaded = await (await fetch(origin + '/api/workspace/snapshot')).json();
  assert.equal(loaded.revision, 1); assert.deepEqual(loaded.snapshot, data);
});

test('a local reverse proxy cannot publish anonymous persistence', () => {
  assert.throws(() => createAppServer({ snapshotStore: {}, allowAnonymous: true, publicOrigin: 'https://public.example' }), /access key/);
});

test('invalid public origin schemes fail before the HTTP server starts', () => {
  assert.throws(() => createAppServer({ publicOrigin: 'ws://localhost' }), /public origin/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createLocalBlobStore, createNodeBlobStore } from '../blob-store.mjs';
import { BlobStoreError, sha256 } from '../../../packages/adapters/src/blob.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yumunio-blob-local-'));
  t.after(async () => {
    const absolute = await realpath(directory);
    assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
    assert.match(basename(absolute), /^yumunio-blob-local-/);
    await rm(absolute, { recursive: true, force: true });
  });
  return directory;
}
test('local attachments survive reopen, keep keys out of filenames and cannot be overwritten', async t => {
  const directory = await fixture(t), config = { driver:'local',directory:join(directory,'private','blobs') };
  const store = await createLocalBlobStore(config), input = new TextEncoder().encode('Private test attachment');
  assert.equal(await store.get('workspace/attachment'), null);
  assert.deepEqual(await store.put('workspace/attachment',input), {size:input.length,checksum:await sha256(input)});
  await assert.rejects(store.put('workspace/attachment',input), error => error instanceof BlobStoreError && error.code==='BLOB_EXISTS');
  assert.deepEqual((await readdir(config.directory)).filter(name=>/^[a-f0-9]{64}$/.test(name)).length,1);
  const reopened = await createLocalBlobStore(config);
  assert.equal(reopened.profileId,store.profileId); assert.deepEqual(await reopened.get('workspace/attachment'),input);
  await assert.rejects(reopened.put('../escape',input), BlobStoreError);
  await reopened.delete('workspace/attachment'); assert.equal(await reopened.get('workspace/attachment'),null);
  await reopened.delete('workspace/attachment');
});
test('local storage rejects symlink directories rather than following them', async t => {
  const directory = await fixture(t), actual = join(directory,'actual'), linked=join(directory,'linked');
  await createLocalBlobStore({driver:'local',directory:actual});
  try { await symlink(actual,linked,process.platform==='win32'?'junction':'dir'); }
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('OS does not allow the fixture symlink');return;}throw error;}
  await assert.rejects(createLocalBlobStore({driver:'local',directory:linked}),BlobStoreError);
});
test('disabled attachment configuration creates no directory or external connection', async () => {
  assert.equal(await createNodeBlobStore({get YUMUNIO_S3_SECRET_ACCESS_KEY(){throw Error('secret must stay unread');}}),null);
});

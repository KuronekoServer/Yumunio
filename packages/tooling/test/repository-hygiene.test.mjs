import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkRepository} from '../repository-hygiene.mjs';

async function fixture(t) {
  const parent = fileURLToPath(new URL('../../../.build/test-fixtures/', import.meta.url));
  await mkdir(parent, {recursive: true});
  const root = await mkdtemp(join(parent, 'yumunio-repository-'));
  t.after(async () => {
    const path = await realpath(root);
    assert.equal(dirname(path).toLowerCase(), (await realpath(parent)).toLowerCase());
    assert.match(basename(path), /^yumunio-repository-/);
    await rm(path, {recursive: true, force: true});
  });
  const git = args => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
  git(['init', '--quiet']);
  const put = async (name, value) => {
    await mkdir(dirname(join(root, name)), {recursive: true});
    await writeFile(join(root, name), value);
  };
  return {root, git, put};
}

test('indexed local data and configuration are rejected even when force-added', async t => {
  const f = await fixture(t);
  for (const name of ['.env.local', '.data/account.json', '.build/report.txt', 'nested/.env', 'export.zip', 'Yumunio.pen']) await f.put(name, 'synthetic');
  await f.put('.env.example', 'YUMUNIO_PUBLIC_ORIGIN=https://notes.example.invalid\n');
  f.git(['add', '--force', '--all']);
  const report = checkRepository(f.root);
  assert.equal(report.files, 7);
  assert.equal(report.problems.length, 6);
  assert.equal(report.problems.some(item => item.path === '.env.example'), false);
});

test('credential checks use staged content and never include a matching value in findings', async t => {
  const f = await fixture(t);
  const {privateKey} = generateKeyPairSync('ed25519', {privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
  await f.put('fixture.txt', privateKey);
  f.git(['add', 'fixture.txt']);
  await f.put('fixture.txt', 'Safe worktree content cannot hide the staged private key.');
  const report = checkRepository(f.root);
  assert.deepEqual(report.problems, [{path: 'fixture.txt', reason: 'private key material'}]);
  assert.equal(JSON.stringify(report).includes(privateKey), false);
  f.git(['add', 'fixture.txt']);
  assert.deepEqual(checkRepository(f.root).problems, []);
});

test('public examples and source pass while recognizable credentials are reported without values', async t => {
  const f = await fixture(t);
  await f.put('deploy/advanced.env.example', 'YUMUNIO_AUTH_SECRET=replace-with-a-generated-value\n');
  await f.put('src/index.js', 'export const label = "Yumunio";\n');
  await f.put('test/sigv4.txt', 'AWS reference example: AKIAIOSFODNN7EXAMPLE');
  f.git(['add', '--all']);
  assert.deepEqual(checkRepository(f.root).problems, []);
  const credential = ['ghp_', 'A'.repeat(36)].join('');
  await f.put('src/accidental.txt', credential);
  f.git(['add', '--all']);
  const report = checkRepository(f.root);
  assert.deepEqual(report.problems, [{path: 'src/accidental.txt', reason: 'GitHub credential'}]);
  assert.equal(JSON.stringify(report).includes(credential), false);
});

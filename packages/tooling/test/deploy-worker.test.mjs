import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { deployWorker } from '../deploy-worker.mjs';
test('first Worker deploy creates private credentials automatically and outputs a ready-to-open initial link', async () => {
  const calls = [], logs = []; let generated, temporary;
  await deployWorker({ env: {}, log: value => logs.push(value), run: async args => {
    calls.push(args);
    if (args[0] === 'secret') return { code: 1, stdout: '', stderr: 'Worker "yumunio" not found.' };
    if (args[0] === 'd1') return args[1] === 'execute' ? { code: 0, stdout: JSON.stringify([{ results: [{ total: 0 }] }]) } : { code: 0 };
    temporary = args[args.indexOf('--secrets-file') + 1]; generated = JSON.parse(await readFile(temporary, 'utf8'));
    return { code: 0, stdout: 'Deployed https://yumunio.fixture.workers.dev', stderr: '' };
  } });
  assert.equal(generated.YUMUNIO_INSTANCE_SECRET.length, 64);
  assert.match(logs[0], /https:\/\/yumunio.fixture.workers.dev\/setup#start=[a-f0-9]{64}$/);
  assert.ok(!logs[0].includes(generated.YUMUNIO_INSTANCE_SECRET));
  assert.deepEqual(calls[1], ['d1', 'migrations', 'apply', 'DB', '--remote']);
  await assert.rejects(() => access(temporary));
});
test('redeploy preserves installed credentials and access errors cannot overwrite them', async () => {
  const calls = [];
  await deployWorker({ log: () => assert.fail('Do not expose another initial link.'), run: async args => { calls.push(args); return args[0] === 'secret' ? { code: 0, stdout: JSON.stringify([{ name: 'YUMUNIO_INSTANCE_SECRET' }]) } : { code: 0 }; } });
  assert.deepEqual(calls[2], ['deploy']);
  let count = 0;
  await assert.rejects(() => deployWorker({ run: async () => { count++; return { code: 1, stdout: '', stderr: 'Unauthorized' }; } }));
  assert.equal(count, 1);
});
test('missing credentials cannot cause a populated installation to receive replacement credentials', async () => {
  const calls = [];
  await assert.rejects(() => deployWorker({ run: async args => {
    calls.push(args); if (args[0] === 'secret') return { code: 0, stdout: '[]' };
    return args[1] === 'execute' ? { code: 0, stdout: JSON.stringify([{ results: [{ total: 1 }] }]) } : { code: 0 };
  } }));
  assert.ok(!calls.some(args => args[0] === 'deploy'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { request } from 'node:http';
import { createAppServer } from '../server.mjs';

test('static host confines files, handles methods, and distinguishes the unavailable API', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'yumunio-static-'));
  const root = join(fixture, 'public');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<h1>Yumunio</h1>');
  await writeFile(join(root, 'app.js'), 'export const test = true;');
  await writeFile(join(root, 'openapi.yaml'), 'openapi: 3.1.0\n');
  await writeFile(join(fixture, 'secret.txt'), 'outside-root');
  await writeFile(join(root, '.secret.json'), '{"private":true}');
  const server = createAppServer({ root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const target = await realpath(fixture);
    const taskTmp = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), taskTmp.toLowerCase());
    assert.match(basename(target), /^yumunio-static-/);
    await rm(target, { recursive: true, force: true });
  });
  const port = server.address().port;
  const raw = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal((await raw('/')).body, '<h1>Yumunio</h1>');
  assert.match((await raw('/app.js')).headers['content-type'], /javascript/);
  assert.equal((await raw('/app.js', 'HEAD')).body, '');
  assert.equal((await raw('/app.js', 'POST')).status, 405);
  const specification=await raw('/openapi.yaml');
  assert.equal(specification.status,200);
  assert.equal(specification.headers['content-type'],'application/yaml; charset=utf-8');
  assert.equal(specification.body,'openapi: 3.1.0\n');
  assert.equal((await raw('/openapi.yaml','HEAD')).body,'');
  assert.equal((await raw('/openapi.yaml','POST')).status,405);
  for (const path of ['/%2e%2e%2fsecret.txt', '/%5c..%5csecret.txt', '/.secret.json', '/missing.js', '/%00', '/%zz']) {
    const result = await raw(path);
    assert.ok([400, 404].includes(result.status), `${path}: ${result.status}`);
    assert.ok(!result.body.includes('outside-root'));
  }
  assert.equal((await raw('/api/pages')).status, 501);
  assert.equal(JSON.parse((await raw('/health')).body).storage, 'browser-local');
});

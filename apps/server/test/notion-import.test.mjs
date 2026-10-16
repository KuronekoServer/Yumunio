import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { createSqliteContentStore } from '@yumunio/identity/content-store';
import { previewNotionImport } from '../../../packages/importer/src/index.js';
import { buildNotionImportBundle } from '../../../packages/importer/src/apply-plan.js';
import { createAppServer } from '../server.mjs';
import { SqliteSnapshotStore } from '../snapshot-store.mjs';

import { archive } from './fixtures/notion-zip.mjs';

test('Notion ZIP conversion commits one private branch over Node HTTP and preserves existing content', async t => {
  const store = new SqliteSnapshotStore(':memory:');
  const mail = [];
  let identity;
  const server = createAppServer({ snapshotStore: store, accessKey: 'notion-import-fixture-'.repeat(3), identity: {
    handle: (...args) => identity.handle(...args), content: (...args) => identity.content(...args)
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await identity?.flushBackgroundTasks(); store.close(); });
  identity = createIdentity({ database: store.database, origin, workspaceContent: true,
    secret: 'notion-http-fixture-secret-'.repeat(3), registrationMode: 'open',
    sendMail: async message => { mail.push(message); return { status: 'accepted' }; } });
  await (await getMigrations(identity.auth.options)).runMigrations();
  store.database.exec(await readFile(new URL('../../../packages/identity/schema/content.sqlite.sql', import.meta.url), 'utf8'));
  identity.content = createAccountContentApi({ store: createSqliteContentStore(store.database), origin,
    resolveSession: request => identity.auth.api.getSession({ headers: request.headers }) });
  let cookie = '', expectedAccountId = '';
  const request = (path, method = 'GET', body) => fetch(origin + path, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
    ...(path.endsWith('/imports') ? { 'X-Yumunio-Expected-Account': expectedAccountId } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const email = 'notion-fixture@example.invalid', password = 'notion-local-fixture-password';
  assert.equal((await request('/api/auth/sign-up/email', 'POST', { name: 'Import fixture', email, password })).status, 202);
  await identity.flushBackgroundTasks();
  const token = new URL(mail.at(-1).text.split('\n').at(-1)).searchParams.get('verify');
  assert.equal((await request('/api/auth/verify-email?token=' + encodeURIComponent(token) + '&callbackURL=' + encodeURIComponent(origin + '/account.html'))).status, 200);
  const login = await request('/api/auth/sign-in/email', 'POST', { email, password });
  assert.equal(login.status, 200);
  expectedAccountId = (await login.json()).user.id;
  cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const created = await request('/api/auth/organization/create', 'POST', { name: 'Import fixture', slug: 'import-fixture' });
  assert.equal(created.status, 200);
  const workspace = await created.json(), base = '/api/content/workspaces/' + workspace.id;
  const originalResponse = await request(base + '/pages', 'POST', { expectedRevision: 0, title: 'Existing note',
    blocks: [{ id: 'existing-block', type: 'paragraph', data: { text: 'Keep this original body' } }] });
  assert.equal(originalResponse.status, 201);
  const original = await originalResponse.json();
  const markdown = '# Import parent\n\nEditable body <script>literal</script>\n\n- [x] A checklist\n';
  const plan = await previewNotionImport(archive([
    ['Parent.md', markdown], ['Parent/Child.md', '# Import child\n\nChild body\n'],
    ['Rows.csv', 'Name,Note\r\nFixture row,"=A1+1"\r\n']
  ]));
  const bundle = buildNotionImportBundle(plan, { expectedRevision: 1, importId: 'notion-http-import-1', rootTitle: 'Imported fixture', csvMode: 'reference',
    acknowledgements: { csvReference: true, linksUnconverted: true, excludedAssets: true } });
  assert.equal(bundle.body.pages.length, 4);
  const invalid = structuredClone(bundle.body); invalid.importId = 'invalid-import';
  invalid.pages.at(-1).parentSourceId = 'missing-parent';
  assert.equal((await request(base + '/imports', 'POST', invalid)).status, 400);
  assert.equal((await (await request(base + '/pages')).json()).pages.length, 1);
  const importedResponse = await request(base + '/imports', 'POST', bundle.body);
  assert.equal(importedResponse.status, 201);
  const imported = await importedResponse.json();
  assert.equal(imported.pageCount, 4); assert.equal(imported.replayed, false); assert.equal(imported.revision, 2);
  const replayResponse = await request(base + '/imports', 'POST', bundle.body);
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.rootPageId, imported.rootPageId); assert.equal(replay.replayed, true);
  const listing = await (await request(base + '/pages')).json();
  assert.equal(listing.pages.length, 5); assert.equal(listing.revision, 2);
  assert.equal('imports' in listing, false); assert.equal('digest' in listing, false);
  const root = listing.pages.find(page => page.id === imported.rootPageId);
  assert.equal(root.parentId, null); assert.equal(root.title, 'Imported fixture');
  const parent = listing.pages.find(page => page.title === 'Import parent');
  const child = listing.pages.find(page => page.title === 'Import child');
  assert.equal(parent.parentId, root.id); assert.equal(child.parentId, parent.id);
  const content = await (await request(base + '/pages/' + parent.id)).json();
  assert.ok(content.document.blocks.some(block => block.type === 'paragraph' && block.data.text.includes('Editable body')));
  assert.equal(content.document.blocks.filter(block => block.data?.purpose === 'import-source').map(block => block.data.text).join(''), markdown);
  const persistedOriginal = await (await request(base + '/pages/' + original.page.id)).json();
  assert.deepEqual(persistedOriginal.document, original.document);
  assert.equal((await store.read()).snapshot, null);
  assert.equal((await request('/api/workspace/snapshot')).status, 401);
});

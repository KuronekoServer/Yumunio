import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTestDatabaseUrl } from '../../../packages/tooling/test/run-databases.mjs';
import { createDatabaseClient } from '@yumunio/adapters/prototype-sql';
import { createIdentity } from '@yumunio/identity';
import { createAccountContentApi } from '@yumunio/identity/content';
import { SqlAccountContentStore } from '@yumunio/identity/content-store';
import { getMigrations } from 'better-auth/db/migration';
import { assertEmptyIdentityTestDatabase, createOwnedIdentityContentTables } from './identity-content-ddl.mjs';
import { exerciseAssignments } from '../../../packages/identity/test/fixtures/assignment-flow.js';

const identityTables = new Set(['yumunio_users','yumunio_auth_sessions','yumunio_auth_accounts','yumunio_auth_verifications','yumunio_workspaces','yumunio_memberships','yumunio_workspace_invitations','yumunio_auth_rate_limits']);
for (const [dialect, envName] of [['mysql','YUMUNIO_TEST_MYSQL_URL'], ['postgres','YUMUNIO_TEST_POSTGRES_URL']]) {
  const url = process.env[envName];
  test(dialect + ' identity and private page API use actual SQL for sessions, CAS, ACL and assignment notifications across adapter reopen', { skip: url ? false : envName + ' not explicitly configured', timeout:90000 }, async t => {
    const { connectionString } = validateTestDatabaseUrl(url, dialect);
    const client = await createDatabaseClient({ dialect, connectionString, sslMode:'disable' });
    const created = [];
    let identity;
    const quote = name => dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"';
    t.after(async () => {
      const errors = [];
      try {
        try { await identity?.flushBackgroundTasks(); } catch(error) { errors.push(error); }
        for (const name of [...created].reverse()) {
          try { await client.query('DROP TABLE ' + quote(name)); } catch(error) { errors.push(error); }
        }
      } finally { await client.end(); }
      if (errors.length) throw new AggregateError(errors, 'Owned identity fixture tables could not be cleaned up.');
    });
    const existing = dialect === 'mysql' ?
      await client.query('SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()') :
      await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema()');
    assertEmptyIdentityTestDatabase(existing);
    const mail = [], origin = 'https://identity-fixture.example.invalid';
    const identityOptions = { database: client.database, origin, secret:'identity-database-fixture-'.repeat(3), registrationMode:'open', workspaceContent:true,
      sendMail: async message => { mail.push(message); return {status:'accepted'}; } };
    identity = createIdentity(identityOptions);
    const plan = await getMigrations(identity.auth.options);
    assert.ok(plan.toBeCreated.every(item => identityTables.has(item.table)));
    // Record ownership only after a known CREATE succeeds. A concurrent existing table must fail instead of being adopted.
    for (const statement of (await plan.compileMigrations()).split(';').map(part=>part.trim()).filter(Boolean)) {
      const table = /^create table [`"]?([a-z0-9_]+)[`"]?\s*\(/i.exec(statement);
      assert.ok(table || /^create (?:unique )?index /i.test(statement), 'Only generated CREATE statements are allowed in this empty fixture.');
      if (table) assert.ok(identityTables.has(table[1]));
      await client.query(statement);
      if (table) created.push(table[1]);
    }
    const contentSchema = await readFile(new URL('../../../packages/identity/schema/content.' + dialect + '.sql', import.meta.url), 'utf8');
    await createOwnedIdentityContentTables(client, contentSchema, dialect, created);
    let contentStore = new SqlAccountContentStore(client);
    await contentStore.checkSchema();
    // Recreate the adapter after explicit DDL, then invalidate any pre-migration schema check with a verified no-op plan.
    identity = createIdentity(identityOptions);
    const ready = await getMigrations(identity.auth.options);
    assert.equal(ready.toBeCreated.length + ready.toBeAdded.length + ready.toBeAddedIndexes.length + ready.schemaProblems.length, 0);
    await ready.runMigrations();
    const request = (path, body, cookie) => identity.handle(new Request(origin + '/api/auth' + path, {
      method: body === undefined ? 'GET' : 'POST', headers:{...(body === undefined ? {} : { Origin:origin,'Content-Type':'application/json' }), ...(cookie ? {Cookie:cookie} : {})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    }), {peerAddress:'127.0.0.1'});
    async function account(email, name) {
      const password = 'database-identity-fixture-password';
      assert.equal((await request('/sign-up/email',{name,email,password})).status,202);
      await identity.flushBackgroundTasks();
      const message = mail.at(-1);
      assert.equal(message.to, email);
      const token = new URL(message.text.split('\n').at(-1)).searchParams.get('verify');
      assert.equal((await request('/verify-email?token='+encodeURIComponent(token)+'&callbackURL='+encodeURIComponent(origin+'/account'))).status,200);
      const login = await request('/sign-in/email',{email,password});
      assert.equal(login.status,200);
      const data = await login.json();
      assert.equal(Object.hasOwn(data,'token'),false);
      const cookie = login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const session = await(await request('/get-session',undefined,cookie)).json();
      assert.equal(session.user.email,email);
      assert.equal(Object.hasOwn(session.session,'token'),false);
      return { user:data.user,cookie };
    }
    const owner = await account('db-identity@example.invalid', 'Database Fixture');
    const member = await account('db-member@example.invalid', 'Member Fixture');
    const workspaceResponse = await request('/organization/create',{name:'SQL Workspace',slug:'sql-workspace'},owner.cookie);
    assert.equal(workspaceResponse.status,200);
    const workspace = await workspaceResponse.json();
    assert.equal((await(await request('/organization/list',undefined,owner.cookie)).json()).length,1);
    const otherResponse = await request('/organization/create',{name:'Other SQL Workspace',slug:'other-sql-workspace'},owner.cookie);
    assert.equal(otherResponse.status,200);
    const otherWorkspace = await otherResponse.json();
    let content = createAccountContentApi({ store:contentStore,origin,
      resolveSession:incoming => identity.auth.api.getSession({headers:incoming.headers}) });
    const path = '/api/content/workspaces/' + workspace.id + '/pages';
    const contentRequest = (path, method='GET', body, cookie=owner.cookie) => {
      const account = [owner,member].find(account => account.cookie===cookie);
      assert.ok(!cookie || account,'Only verified fixture cookies may authenticate content requests.');
      return content(new Request(origin+path, {
        method,headers:{...(body === undefined ? {} : {Origin:origin,'Content-Type':'application/json'}),...(account ? {Cookie:cookie,'X-Yumunio-Expected-Account':account.user.id} : {})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)})
      }));
    };
    assert.equal((await contentRequest(path,'GET',undefined,'')).status,401);
    assert.equal((await contentRequest(path,'GET',undefined,member.cookie)).status,404);
    // Membership administration is not a public API yet. Insert only a row in this newly owned fixture.
    const columns = ['id','organizationId','userId','role','createdAt'].map(quote).join(', ');
    const placeholders = dialect === 'mysql' ? '?, ?, ?, ?, ?' : '$1, $2, $3, $4, $5';
    await client.query('INSERT INTO yumunio_memberships (' + columns + ') VALUES (' + placeholders + ')',
      ['fixture-content-member',workspace.id,member.user.id,'member',new Date()]);
    const empty = await contentRequest(path,'GET',undefined,member.cookie);
    assert.equal(empty.status,200); assert.deepEqual((await empty.json()).pages,[]);
    const createdPage = await contentRequest(path,'POST',{expectedRevision:0,title:'Private SQL page \u65e5\u672c\u8a9e \ud83d\udc08',
      blocks:[{id:'sql-paragraph',type:'paragraph',data:{text:"Owned content '; DROP TABLE yumunio_users; --"}}]});
    assert.equal(createdPage.status,201); const page = await createdPage.json();
    assert.equal(page.revision,1); assert.equal(page.document.version,1);
    const pagePath = path + '/' + page.page.id;
    const ownerRead = await contentRequest(pagePath);
    assert.equal(ownerRead.status,200);
    assert.deepEqual((await ownerRead.json()).document.blocks,page.document.blocks);
    const filtered = await contentRequest(path,'GET',undefined,member.cookie);
    assert.equal(filtered.status,200);
    const projection = await filtered.json();
    assert.deepEqual(projection.pages,[]);
    for (const key of ['payload','principals','grants','grantBindings']) assert.equal(Object.hasOwn(projection,key),false);
    assert.equal((await contentRequest(pagePath,'GET',undefined,member.cookie)).status,404);
    assert.equal((await contentRequest('/api/content/workspaces/'+otherWorkspace.id+'/pages/'+page.page.id)).status,404);
    const grantResponse = await contentRequest(pagePath+'/grants','POST',{expectedRevision:1,accountId:member.user.id,permission:'viewer'});
    assert.equal(grantResponse.status,200); const granted = await grantResponse.json();
    assert.equal(granted.revision,2);
    const visible = await contentRequest(path,'GET',undefined,member.cookie);
    assert.deepEqual((await visible.json()).pages.map(item=>item.id),[page.page.id]);
    assert.equal((await contentRequest(pagePath,'GET',undefined,member.cookie)).status,200);
    assert.equal((await contentRequest(pagePath,'PATCH',{expectedRevision:2,expectedVersion:1,title:'Unauthorized edit'},member.cookie)).status,404);
    const updated = await contentRequest(pagePath,'PATCH',{expectedRevision:2,expectedVersion:1,title:'Saved SQL title \u65e5\u672c\u8a9e \ud83d\udc08'});
    assert.equal(updated.status,200); const saved = await updated.json();
    assert.equal(saved.revision,3); assert.equal(saved.document.version,2);
    assert.equal((await contentRequest(pagePath,'PATCH',{expectedRevision:2,expectedVersion:1,title:'Stale edit'})).status,409);
    const revoke = await contentRequest(pagePath+'/grants/'+granted.grant.id,'DELETE',{expectedRevision:3});
    assert.equal(revoke.status,200); assert.equal((await revoke.json()).revision,4);
    assert.equal((await contentRequest(pagePath,'GET',undefined,member.cookie)).status,404);
    assert.deepEqual((await contentRequest(path,'GET',undefined,member.cookie)).status,200);
    assert.deepEqual((await(await contentRequest(path,'GET',undefined,member.cookie)).json()).pages,[]);
    const persisted = await contentStore.read(workspace.id,owner.user.id);
    assert.equal(persisted.revision,4);
    assert.equal(persisted.payload.pages[0].page.title,saved.page.title);
    assert.equal((await contentStore.read(otherWorkspace.id,owner.user.id)).revision,0);
    // Same real SQL pool and verified cookies; reopen adapters only, not an OS or server process.
    let memberMembershipId = 'fixture-content-member';
    await exerciseAssignments({
      owner:{id:owner.user.id,cookie:owner.cookie}, member:{id:member.user.id,cookie:member.cookie}, workspaceId:workspace.id,
      request:(path,{method='GET',body,account,headers={}}={}) => content(new Request(origin+path, {
        method,headers:{...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),
          ...(account?{Cookie:account.cookie,'X-Yumunio-Expected-Account':account.id}:{}),...headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      })),
      async restart() {
        await identity.flushBackgroundTasks();
        identity = createIdentity(identityOptions);
        contentStore = new SqlAccountContentStore(client);
        await contentStore.checkSchema();
        content = createAccountContentApi({store:contentStore,origin,
          resolveSession:incoming => identity.auth.api.getSession({headers:incoming.headers})});
      },
      async replaceMembership(accountId) {
        assert.equal(accountId,member.user.id,'Only the synthetic member generation can change.');
        const marker = index => dialect==='mysql'?'?':'$'+index;
        const where = ['id','organizationId','userId','role'].map((name,index)=>quote(name)+' = '+marker(index+1)).join(' AND ');
        const values = [memberMembershipId,workspace.id,member.user.id,'member'];
        const before = await client.query('SELECT '+columns+' FROM yumunio_memberships WHERE '+where,values);
        assert.equal(before.rows.length,1,'The exact owned member generation must still exist.');
        const nextId = 'fixture-assignment-rejoined-member';
        const updateWhere = ['id','organizationId','userId','role'].map((name,index)=>quote(name)+' = '+marker(index+2)).join(' AND ');
        const result = await client.query('UPDATE yumunio_memberships SET '+quote('id')+' = '+marker(1)+' WHERE '+updateWhere,[nextId,...values]);
        assert.equal(result.affectedRows,1,'Only one owned member generation may be replaced.');
        const after = await client.query('SELECT '+columns+' FROM yumunio_memberships WHERE '+where,[nextId,...values.slice(1)]);
        assert.equal(after.rows.length,1);
        memberMembershipId=nextId;
      }
    });
    assert.equal((await request('/sign-out',{},owner.cookie)).status,200);
    assert.equal(await(await request('/get-session',undefined,owner.cookie)).json(),null);
    assert.equal((await contentRequest(pagePath)).status,401);
  });
}

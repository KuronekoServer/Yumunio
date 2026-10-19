import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {SETUP_SCHEMA} from '../../identity/src/setup-store.js';
const read=path=>readFile(new URL('../../../'+path,import.meta.url),'utf8');
test('default Compose pulls the public image and persists account and attachment data without building source',async()=>{
  const compose=parse(await read('compose.yaml')),service=compose.services.yumunio;
  assert.equal(service.image,'${YUMUNIO_IMAGE:-docker.io/kuronekoserver/yumunio:latest}');
  assert.equal(service.build,undefined);assert.equal(service.environment.YUMUNIO_STORAGE,'${YUMUNIO_STORAGE:-sqlite}');
  assert.equal(service.environment.YUMUNIO_BLOB_LOCAL_DIR,'/app/.data/blobs');
  assert.deepEqual(service.volumes,['yumunio-data:/app/.data']);
  assert.equal(parse(await read('compose.build.yaml')).services.yumunio.build,'.');
});
test('root Workers template binds fresh D1/R2, generates credentials on deploy and routes setup APIs through the Worker',async()=>{
  const config=JSON.parse(await read('wrangler.jsonc'));
  assert.equal(config.main,'apps/worker/worker.js');assert.equal(config.assets.html_handling,'none');
  for(const path of ['/','/index.html','/api/*'])assert.ok(config.assets.run_worker_first.includes(path));
  assert.equal(config.vars.YUMUNIO_WEB_SETUP,'true');assert.equal(config.secrets,undefined);
  assert.equal(config.d1_databases[0].binding,'DB');assert.equal(config.r2_buckets[0].binding,'BLOBS');
  assert.deepEqual(config.durable_objects.bindings,[{name:'ROOMS',class_name:'PageRoom'}]);
  assert.deepEqual(config.migrations,[{tag:'v1',new_sqlite_classes:['PageRoom']}]);
  const local=JSON.parse(await read('apps/worker/wrangler.jsonc'));assert.deepEqual(local.durable_objects,config.durable_objects);assert.deepEqual(local.migrations,config.migrations);
  assert.ok(JSON.parse(await read('package.json')).cloudflare.bindings.ROOMS.description);
  assert.deepEqual(config.triggers.crons,['* * * * *']);
  const schema=await read(config.d1_databases[0].migrations_dir+'/0001_install.sql');
  for(const path of ['apps/worker/auth-schema.sql','apps/worker/snapshot-schema.sql'])assert.ok(schema.replace(/\r/g,'').includes((await read(path)).replace(/\r/g,'')));
  assert.ok(schema.includes(SETUP_SCHEMA));
  const scripts=JSON.parse(await read('package.json')).scripts;
  assert.equal(scripts.deploy,'node packages/tooling/deploy-worker.mjs');
});
test('Compose passes application env at runtime with stable container bind and no database bootstrap passwords',async()=>{
  const source=await read('compose.yaml');
  assert.match(source,/env_file:\s*\n\s+- path: \.env\s*\n\s+required: false/);
  assert.match(source,/YUMUNIO_HOST: 0\.0\.0\.0/);
  assert.match(source,/YUMUNIO_PORT: "8788"/);
  for(const key of ['YUMUNIO_DB_PASSWORD','YUMUNIO_DB_ADMIN_PASSWORD'])assert.match(source,new RegExp(key+': ""'));
  assert.match(source,/"127\.0\.0\.1:8788:8788"/);
});
test('database Compose profiles keep DB network private and explicit TLS overrides ahead of runtime env',async()=>{
  for(const [name,dialect]of [['mariadb','mariadb'],['postgres','postgres']]){
    const source=await read('compose.'+name+'.yaml');
    for(const text of [source.replace(/\r\n/g,'\n'),source.replace(/\r?\n/g,'\r\n')]){
      const {services}=parse(text),database=services.database,application=services.yumunio;
      assert.ok(database);
      assert.equal(database.ports,undefined);
      assert.equal(database.env_file,undefined);
      assert.equal(application.environment.YUMUNIO_STORAGE,dialect);
      assert.match(application.environment.YUMUNIO_DATABASE_URL,/^\$\{YUMUNIO_DATABASE_URL:\?/);
      assert.equal(application.environment.YUMUNIO_DATABASE_TLS,'${YUMUNIO_DATABASE_TLS:-verify-full}');
      assert.equal(application.depends_on.database.condition,'service_healthy');
    }
  }
});
test('runtime credentials, local databases and Pen assets cannot enter Docker build context',async()=>{
  const ignore=(await read('.dockerignore')).split(/\r?\n/).filter(Boolean);
  for(const pattern of ['.env','.env.*','.data','.build','*.pen','design'])assert.ok(ignore.includes(pattern),pattern+' must stay excluded');
  const dockerfile=await read('Dockerfile');
  assert.doesNotMatch(dockerfile,/^\s*(?:ARG|ENV)\s+(?:YUMUNIO_(?:AUTH_SECRET|DATABASE_URL|SMTP_PASSWORD|BLOB_SECRET_ACCESS_KEY|BACKUP_ENCRYPTION_KEY))\b/m);
  assert.match(dockerfile,/USER node/);
  assert.match(dockerfile,/npm ci --ignore-scripts/);
  assert.match(dockerfile,/^COPY openapi\.yaml \.\/openapi\.yaml$/m);
  assert.doesNotMatch(dockerfile,/^COPY docs(?:\s|\/\*)/m);
});
test('PostgreSQL bootstrap uses a separate application role and literal-safe psql password binding',async()=>{
  const script=await read('deploy/postgres/init.sh'),compose=await read('compose.postgres.yaml');
  assert.match(script,/CREATE ROLE yumunio LOGIN PASSWORD :'app_password'/);
  assert.match(script,/SET ROLE yumunio;/);
  assert.doesNotMatch(script,/CREATE ROLE yumunio[^;]*SUPERUSER/);
  assert.match(compose,/POSTGRES_PASSWORD: "\$\{YUMUNIO_DB_ADMIN_PASSWORD:\?/);
  assert.match(compose,/YUMUNIO_DB_PASSWORD: "\$\{YUMUNIO_DB_PASSWORD:\?/);
});

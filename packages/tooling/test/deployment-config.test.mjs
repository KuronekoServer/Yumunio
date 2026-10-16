import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../../../'+path,import.meta.url),'utf8');
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
    const database=source.split('\n  database:\n')[1]?.split('\nvolumes:')[0];
    assert.ok(database);
    assert.doesNotMatch(database,/^\s+ports:/m);
    assert.doesNotMatch(database,/^\s+env_file:/m);
    assert.match(source,new RegExp('YUMUNIO_STORAGE: '+dialect));
    assert.match(source,/YUMUNIO_DATABASE_URL: "\$\{YUMUNIO_DATABASE_URL:\?/);
    assert.match(source,/YUMUNIO_DATABASE_TLS: "\$\{YUMUNIO_DATABASE_TLS:-verify-full\}"/);
    assert.match(source,/condition: service_healthy/);
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

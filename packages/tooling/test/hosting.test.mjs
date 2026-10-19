import test from 'node:test';
import assert from 'node:assert/strict';
import {link,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {parse} from 'yaml';
import {hostingOrigin,parseHostingOptions,prepareHosting} from '../prepare-hosting.mjs';
import {createHostingBundle} from '../hosting-bundle.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(t){
 const parent=join(root,'.build/test-fixtures');await mkdir(parent,{recursive:true});const folder=await mkdtemp(join(parent,'yumunio-hosting-'));
 t.after(async()=>{assert.equal(dirname(resolve(folder)),resolve(parent));await rm(folder,{recursive:true,force:true});});return folder;
}

test('a prepared local installation keeps data persistent and never overwrites existing settings',async t=>{
 const folder=await fixture(t),directory=join(folder,'install'),result=await prepareHosting({root,directory});
 assert.equal(result.origin,'http://127.0.0.1:8788');assert.deepEqual(result.commands,['docker compose pull','docker compose up -d','docker compose logs yumunio']);
 const config=parse(await readFile(join(directory,'compose.yaml'),'utf8'));
 assert.deepEqual(config.services.yumunio.volumes,['yumunio-data:/app/.data']);assert.deepEqual(config.services.yumunio.ports,['127.0.0.1:8788:8788']);
 const settings=await readFile(join(directory,'.env'),'utf8');assert.doesNotMatch(settings,/YUMUNIO_(?:AUTH_SECRET|ACCESS_KEY|SMTP_PASSWORD)=/);
 await writeFile(join(directory,'.env'),'EXISTING-OPERATOR-SETTING\n');
 await assert.rejects(prepareHosting({root,directory,origin:'https://example.invalid'}),/already exists/);
 assert.equal(await readFile(join(directory,'.env'),'utf8'),'EXISTING-OPERATOR-SETTING\n');
});

test('HTTPS preparation provides one public origin, an isolated proxy and persistent certificates',async t=>{
 const folder=await fixture(t),directory=join(folder,'https'),result=await prepareHosting({root,directory,origin:'https://Notes.Example.invalid/',https:true,image:'ghcr.io/kuronekoserver/yumunio:0.1.0'});
 assert.equal(result.origin,'https://notes.example.invalid');assert.ok(result.commands.every(command=>command.includes('-f compose.yaml -f compose.https.yaml')));
 assert.match(await readFile(join(directory,'.env'),'utf8'),/^YUMUNIO_PUBLIC_ORIGIN=https:\/\/notes\.example\.invalid$/m);
 const config=parse(await readFile(join(directory,'compose.https.yaml'),'utf8')),caddy=config.services.caddy;
 assert.deepEqual(caddy.ports,['80:80','443:443','443:443/udp']);assert.equal(caddy.depends_on.yumunio.condition,'service_healthy');
 assert.ok(caddy.volumes.includes('yumunio-caddy-data:/data'));
 const base=parse(await readFile(join(directory,'compose.yaml'),'utf8'));assert.ok(base.services.yumunio.healthcheck.test.some(value=>value.includes('/health')));
 assert.match(await readFile(join(directory,'deploy/Caddyfile'),'utf8'),/reverse_proxy yumunio:8788/);
 assert.doesNotMatch(await readFile(join(directory,'deploy/Caddyfile'),'utf8'),/header_up Host/);
});

test('public hosting rejects ambiguous origins, configuration injection and destructive destinations',async t=>{
 const folder=await fixture(t);
 for(const origin of ['http://notes.example.invalid','https://notes.example.invalid/path','https://user:password@notes.example.invalid','https://notes.example.invalid/?value=1','https://notes.example.invalid/#x','https://notes.example.invalid\nEVIL=value','https://evil{domain}.invalid','https://notes.example.invalid\\path','http://localhost:9999'])assert.throws(()=>hostingOrigin(origin),undefined,origin);
 for(const origin of [undefined,'https://localhost','https://127.0.0.1','https://[::1]','https://notes.example.invalid:8443'])assert.throws(()=>hostingOrigin(origin,{https:true}));
 assert.equal(hostingOrigin('http://localhost:8788/'),'http://localhost:8788');
 await assert.rejects(prepareHosting({root,directory:join(folder,'bad'),image:'image\nOTHER=1'}),/Invalid hosting options/);
 await assert.rejects(readFile(join(folder,'bad/.env')),{code:'ENOENT'});
 for(const args of [['--https','--https'],['--origin'],['--unknown','value'],['--directory','a','--directory','b']])assert.throws(()=>parseHostingOptions(args));
 assert.deepEqual(parseHostingOptions(['--directory','install','--origin','https://notes.example.invalid','--https']),{directory:'install',origin:'https://notes.example.invalid',https:true});
});

test('the portable hosting ZIP excludes operator data and has reproducible contents and SHA-256',async t=>{
 const folder=await fixture(t),sources=['compose.yaml','compose.https.yaml','deploy/Caddyfile','.env.example','deploy/README.hosting.md','LICENSE'];
 for(const source of sources){const target=join(folder,source);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(root,source)));}
 await writeFile(join(folder,'.env'),'PRIVATE-OPERATOR-SECRET');await mkdir(join(folder,'.data'));await writeFile(join(folder,'.data/instance-secret'),'PRIVATE-INSTANCE-SECRET');
 const result=await createHostingBundle(folder),zip=await readFile(result.bundle),names=[],contents=new Map();let offset=0;
 while(zip.readUInt32LE(offset)===0x04034b50){
  const size=zip.readUInt32LE(offset+18),length=zip.readUInt16LE(offset+26),start=offset+30+length,name=zip.subarray(offset+30,start).toString(),bytes=zip.subarray(start,start+size);
  assert.equal(crc32(bytes),zip.readUInt32LE(offset+14));assert.equal(zip.readUInt16LE(offset+8),0);names.push(name);contents.set(name,bytes);offset=start+size;
 }
 assert.deepEqual(names,['compose.yaml','compose.https.yaml','deploy/Caddyfile','.env','README.md','LICENSE']);assert.equal(zip.readUInt32LE(offset),0x02014b50);
 assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.equal(zip.readUInt16LE(zip.length-12),names.length);
 assert.deepEqual(contents.get('.env'),await readFile(join(root,'.env.example')));assert.match(contents.get('README.md').toString(),/docker compose pull/);
 assert.equal(zip.includes(Buffer.from('PRIVATE-')),false);
 assert.equal(result.sha256,createHash('sha256').update(zip).digest('hex'));assert.equal(await readFile(result.checksum,'utf8'),result.sha256+'  yumunio-hosting.zip\n');
 assert.equal((await createHostingBundle(folder)).sha256,result.sha256);
});

test('bundle generation preserves an output that is linked to an operator file',async t=>{
 const folder=await fixture(t);
 for(const source of ['compose.yaml','compose.https.yaml','deploy/Caddyfile','.env.example','deploy/README.hosting.md','LICENSE']){const target=join(folder,source);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(root,source)));}
 await mkdir(join(folder,'.build'));const operator=join(folder,'operator-settings');await writeFile(operator,'KEEP-OPERATOR-DATA');await link(operator,join(folder,'.build/yumunio-hosting.zip'));
 await assert.rejects(createHostingBundle(folder),/Invalid hosting bundle file/);assert.equal(await readFile(operator,'utf8'),'KEEP-OPERATOR-DATA');
});

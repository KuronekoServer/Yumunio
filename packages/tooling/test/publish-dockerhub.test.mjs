import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parse} from 'yaml';
import {dockerHubReleasePlan,publishDockerHub} from '../publish-dockerhub.mjs';

const env={GITHUB_REPOSITORY:'KuronekoServer/Yumunio',GITHUB_REF:'refs/heads/master',GITHUB_SHA:'a'.repeat(40),DOCKERHUB_IMAGE:'kuronekoserver/yumunio',DOCKERHUB_USERNAME:'synthetic-publisher',DOCKERHUB_TOKEN:'synthetic-docker-secret',GITHUB_ACTOR:'synthetic-github-publisher',GHCR_TOKEN:'synthetic-github-secret'};
const manifest=JSON.stringify({manifests:['amd64','arm64'].map(architecture=>({platform:{os:'linux',architecture}}))});

test('Docker Hub uses tested commit-specific images for both architectures and a separate version tag',()=>{
 const plan=dockerHubReleasePlan(env);assert.equal(plan.destination,'docker.io/kuronekoserver/yumunio:latest');
 assert.deepEqual(plan.images.map(image=>image.source),['ghcr.io/kuronekoserver/yumunio:sha-'+env.GITHUB_SHA+'-amd64','ghcr.io/kuronekoserver/yumunio:sha-'+env.GITHUB_SHA+'-arm64']);
 assert.equal(dockerHubReleasePlan({...env,GITHUB_REF:'refs/tags/v1.2.3-rc.1'}).destination,'docker.io/kuronekoserver/yumunio:1.2.3-rc.1');
 for(const patch of [{GITHUB_REF:'refs/pull/1/merge'},{GITHUB_REF:'refs/heads/topic'},{GITHUB_REF:'refs/tags/v'},{GITHUB_REF:'refs/tags/v1.2+unsafe'},{GITHUB_SHA:'not-a-commit'},{DOCKERHUB_IMAGE:'other.invalid/namespace/image'},{DOCKERHUB_IMAGE:'namespace/image:latest'},{DOCKERHUB_IMAGE:'name/image\nEXTRA=1'}])assert.throws(()=>dockerHubReleasePlan({...env,...patch}));
});

test('publication copies both architectures without rebuilding, checks anonymous access and disposes credentials',async()=>{
 const calls=[],logs=[];const result=await publishDockerHub({env,log:line=>logs.push(line),run:async(args,options)=>{
  calls.push({args,...options});if(args[0]==='login')await writeFile(join(options.config,'config.json'),JSON.stringify({auths:{synthetic:options.input}}));
  if(args[0]==='manifest'&&args[1]==='inspect')assert.deepEqual(JSON.parse(await readFile(join(options.config,'config.json'),'utf8')),{auths:{'https://index.docker.io/v1/':{}}});
  return{code:0,stdout:args[0]==='manifest'&&args[1]==='inspect'?manifest:''};
 }});
 assert.equal(calls.filter(call=>call.args[0]==='pull').length,2);assert.equal(calls.some(call=>call.args[0]==='build'),false);
 for(const image of result.images){assert.ok(calls.some(call=>JSON.stringify(call.args)===JSON.stringify(['tag',image.source,image.destination])));assert.ok(calls.some(call=>JSON.stringify(call.args)===JSON.stringify(['push',image.destination])));}
 const create=calls.find(call=>call.args[1]==='create');assert.deepEqual(create.args,['manifest','create',result.destination,...result.images.map(image=>image.destination)]);
 const inspector=calls.at(-1);assert.deepEqual(inspector.args,['manifest','inspect',result.destination]);assert.notEqual(inspector.config,calls[0].config);assert.equal(inspector.input,'');
 assert.equal(calls[0].input,env.GHCR_TOKEN);assert.equal(calls[1].input,env.DOCKERHUB_TOKEN);
 assert.doesNotMatch(JSON.stringify(calls.map(call=>call.args))+logs.join('\n'),/synthetic-(?:docker|github)-secret/);
 await assert.rejects(access(calls[0].config),{code:'ENOENT'});assert.match(logs.at(-1),/without login/);
});

test('missing credentials fail before any registry operation',async()=>{
 for(const key of ['DOCKERHUB_USERNAME','DOCKERHUB_TOKEN','GHCR_TOKEN']){let calls=0;await assert.rejects(publishDockerHub({env:{...env,[key]:''},run:async()=>{calls++;}}),/Configure/);assert.equal(calls,0);}
});

test('a failed architecture push prevents a partial public tag and never exposes provider diagnostics',async()=>{
 const calls=[];await assert.rejects(publishDockerHub({env,log:()=>{},run:async(args,options)=>{calls.push({args,...options});return{code:args[0]==='push'?1:0,stdout:'provider diagnostic '+env.DOCKERHUB_TOKEN};}}),error=>{assert.match(error.message,/failed during push/);assert.ok(!error.message.includes(env.DOCKERHUB_TOKEN));return true;});
 assert.equal(calls.some(call=>call.args[0]==='manifest'),false);await assert.rejects(access(calls[0].config),{code:'ENOENT'});
});

test('private repositories, incomplete manifests and malformed public responses cannot report success',async()=>{
 for(const response of [{code:1,stdout:''},{code:0,stdout:'not JSON'},{code:0,stdout:JSON.stringify({manifests:[{platform:{os:'linux',architecture:'amd64'}}]})}]){
  const logs=[];await assert.rejects(publishDockerHub({env,log:line=>logs.push(line),run:async args=>args[0]==='manifest'&&args[1]==='inspect'?response:{code:0,stdout:''}}));assert.equal(logs.some(line=>line.startsWith('Public image verified')),false);
 }
});

test('Docker Hub publication waits for successful GHCR builds and uses only repository publishing credentials',async()=>{
 const workflow=parse(await readFile(new URL('../../../.github/workflows/container.yaml',import.meta.url),'utf8')),{dockerhub}=workflow.jobs;
 assert.equal(dockerhub.needs,'manifest');assert.match(dockerhub.if,/vars\.DOCKERHUB_IMAGE != ''/);assert.deepEqual(dockerhub.permissions,{contents:'read',packages:'read'});
 assert.equal(workflow.on.pull_request,undefined);assert.equal(workflow.on.pull_request_target,undefined);
 const step=dockerhub.steps.find(step=>step.run);assert.equal(step.run,'node packages/tooling/publish-dockerhub.mjs');assert.equal(step.env.DOCKERHUB_TOKEN,'${{ secrets.DOCKERHUB_TOKEN }}');
 assert.equal(workflow.jobs.manifest.needs,'build');
});

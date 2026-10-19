import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const architectures=['amd64','arm64'];
/** Mirror the already tested, commit-specific images; never rebuild different bytes for Docker Hub. */
export function dockerHubReleasePlan(env){
 const {GITHUB_REPOSITORY:repository,GITHUB_REF:ref,GITHUB_SHA:sha,DOCKERHUB_IMAGE:image}=env;
 if(typeof repository!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(repository)||!(/^[a-f0-9]{40}$/.test(sha??'')))throw Error('Invalid source repository or commit.');
 if(typeof image!=='string'||image.length>255||!(/^[a-z0-9][a-z0-9_-]*\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(image)))throw Error('DOCKERHUB_IMAGE must be a lowercase namespace/repository without a registry or tag.');
 const tag=ref==='refs/heads/master'?'latest':ref?.startsWith('refs/tags/v')?ref.slice('refs/tags/v'.length):null;
 if(!tag||!(/^[\w][\w.-]{0,127}$/.test(tag)))throw Error('Publish only master or a v-prefixed Docker-compatible version tag.');
 const source='ghcr.io/'+repository.toLowerCase(),destination='docker.io/'+image;
 return{tag,destination:destination+':'+tag,images:architectures.map(arch=>({arch,source:source+':sha-'+sha+'-'+arch,destination:destination+':sha-'+sha+'-'+arch}))};
}
function runDocker(args,{input='',config,capture=false}={}){
 return new Promise((done,reject)=>{
  const childEnv={...process.env};for(const key of ['DOCKERHUB_TOKEN','GHCR_TOKEN','GITHUB_TOKEN','DOCKER_AUTH_CONFIG'])delete childEnv[key];
  const child=spawn('docker',['--config',config,...args],{env:childEnv,stdio:['pipe',capture?'pipe':'inherit','pipe'],windowsHide:true});let stdout='';
  child.stdout?.on('data',data=>{stdout+=data;});child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>{});child.stdin.end(input);child.once('error',()=>reject(Error('Unable to start Docker.')));child.once('exit',code=>done({code,stdout}));
 });
}
export async function publishDockerHub({env=process.env,run=runDocker,log=console.log}={}){
 const plan=dockerHubReleasePlan(env);
 for(const key of ['DOCKERHUB_USERNAME','DOCKERHUB_TOKEN','GITHUB_ACTOR','GHCR_TOKEN'])if(typeof env[key]!=='string'||!env[key]||env[key].length>8192||/[\r\n\0]/.test(env[key]))throw Error('Configure DOCKERHUB_USERNAME, DOCKERHUB_TOKEN and GitHub registry access before publishing.');
 const parent=resolve(tmpdir()),directory=await mkdtemp(join(parent,'yumunio-docker-publish-'));
 const config=join(directory,'publisher'),anonymous=join(directory,'anonymous');
 async function command(args,{input='',capture=false,publicRead=false}={}){
  const result=await run(args,{input,config:publicRead?anonymous:config,capture});
  if(result.code!==0)throw Error('Docker Hub publication failed during '+args[0]+'. Check repository visibility, permissions and Docker availability.');return result;
 }
 try{
  await mkdir(config,{mode:0o700});await mkdir(anonymous,{mode:0o700});
  // An explicit empty Docker Hub auth entry also prevents automatic credential-store discovery.
  await writeFile(join(config,'config.json'),JSON.stringify({auths:{'ghcr.io':{},'https://index.docker.io/v1/':{}}}),{mode:0o600});
  await writeFile(join(anonymous,'config.json'),JSON.stringify({auths:{'https://index.docker.io/v1/':{}}}),{mode:0o600});
  await command(['login','ghcr.io','--username',env.GITHUB_ACTOR,'--password-stdin'],{input:env.GHCR_TOKEN,capture:true});
  await command(['login','docker.io','--username',env.DOCKERHUB_USERNAME,'--password-stdin'],{input:env.DOCKERHUB_TOKEN,capture:true});
  for(const image of plan.images){
   log('Publishing linux/'+image.arch+' from '+image.source);
   await command(['pull','--platform','linux/'+image.arch,image.source]);await command(['tag',image.source,image.destination]);await command(['push',image.destination]);
  }
  await command(['manifest','create',plan.destination,...plan.images.map(image=>image.destination)]);await command(['manifest','push',plan.destination]);
  const response=await command(['manifest','inspect',plan.destination],{capture:true,publicRead:true});let manifest;
  try{manifest=JSON.parse(response.stdout);}catch{throw Error('Published image did not return a public multi-platform manifest.');}
  for(const arch of architectures)if(!manifest.manifests?.some(item=>item.platform?.os==='linux'&&item.platform.architecture===arch))throw Error('Public manifest is missing linux/'+arch+'.');
  log('Public image verified without login: '+plan.destination+' (linux/amd64, linux/arm64)');return plan;
 }finally{
  if(dirname(resolve(directory))!==parent||!directory.startsWith(join(parent,'yumunio-docker-publish-')))throw Error('Unexpected Docker credential directory.');
  await rm(directory,{recursive:true,force:true});
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await publishDockerHub();}catch(error){console.error(error.message);process.exitCode=1;}}

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, createSign, createHash, randomUUID } from 'node:crypto';
import { getMigrations } from 'better-auth/db/migration';
import { createIdentity, readIdentityConfig, createDomainPolicy } from '../src/index.js';
import { readOAuthConfig, validateOAuthConfig } from '../src/oauth.js';

const origin = 'https://workspace.fixture.invalid';
const fixtureSecret = 'external-identity-fixture-secret-'.repeat(3);
const oauthEnv = () => ({
  ...Object.fromEntries(['GOOGLE','GITHUB','DISCORD'].flatMap(id=>[
    ['YUMUNIO_OAUTH_'+id+'_CLIENT_ID',id.toLowerCase()+'-fixture-client'],
    ['YUMUNIO_OAUTH_'+id+'_CLIENT_SECRET',id.toLowerCase()+'-fixture-private-secret']
  ])),
  YUMUNIO_OIDC_ENABLED:'true',YUMUNIO_OIDC_ISSUER:'https://id.fixture.invalid',
  YUMUNIO_OIDC_CLIENT_ID:'oidc-fixture-client',YUMUNIO_OIDC_CLIENT_SECRET:'oidc-fixture-private-secret',YUMUNIO_OIDC_DISPLAY_NAME:'Fixture SSO'
});
const cookies = response => response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const b64 = object => Buffer.from(JSON.stringify(object)).toString('base64url');

async function fixture(t, options = {}) {
  const originalFetch = globalThis.fetch;
  const key = generateKeyPairSync('rsa',{modulusLength:2048});
  const kid = 'fixture-'+randomUUID();
  const jwk = {...key.publicKey.export({format:'jwk'}),kid,alg:'RS256',use:'sig'};
  const database = new DatabaseSync(':memory:');
  const env = {...oauthEnv(),...options.env};
  const state = { email:'external@studio.example',verified:true,subject:'provider-user-1',issuer:env.YUMUNIO_OIDC_ISSUER,
    claims:{},invalidSignature:false,metadata:null,tokenCalls:[],fetches:[],nonce:'',challenge:'',...options.state };
  function signedToken(provider) {
    const now = Math.floor(Date.now()/1000);
    const claims = {iss:provider === 'google' ? 'https://accounts.google.com' : state.issuer,
      aud:provider === 'google' ? 'google-fixture-client' : 'oidc-fixture-client',sub:state.subject,
      exp:now+600,iat:now,nonce:state.nonce,email:state.email,email_verified:state.verified,name:'Fixture Person',...state.claims};
    const payload = b64({alg:'RS256',kid,typ:'JWT'})+'.'+b64(claims);
    const signature = createSign('RSA-SHA256').update(payload).sign(key.privateKey).toString('base64url');
    return payload+'.'+(state.invalidSignature ? Buffer.alloc(256).toString('base64url') : signature);
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    state.fetches.push(url.origin+url.pathname);
    if (url.pathname.endsWith('/.well-known/openid-configuration') && url.hostname === 'id.fixture.invalid') {
      return Response.json(state.metadata ?? {issuer:state.issuer,authorization_endpoint:state.issuer+'/authorize',token_endpoint:state.issuer+'/token',
        jwks_uri:state.issuer+'/jwks',id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
    }
    if ((url.hostname === 'id.fixture.invalid' && url.pathname.endsWith('/jwks')) || url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({keys:[jwk]});
    const provider = url.hostname === 'oauth2.googleapis.com' ? 'google' : url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token' ? 'github' :
      url.hostname === 'discord.com' && url.pathname === '/api/oauth2/token' ? 'discord' : url.hostname === 'id.fixture.invalid' && url.pathname.endsWith('/token') ? 'oidc' : null;
    if (provider) {
      if (state.tokenFailure) return Response.json({error:'private-provider-error',error_description:'private-fixture-token-and-client-secret'},{status:400});
      const body = new URLSearchParams(init.body);
      state.tokenCalls.push({provider,hasSecret:body.has('client_secret'),code:body.get('code')});
      if (provider !== 'discord') {
        assert.ok(body.get('code_verifier'));
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),state.challenge);
      }
      return Response.json({access_token:'fixture-access-token',token_type:'Bearer',expires_in:600,
        ...((provider === 'google' || provider === 'oidc') && !state.omitIdToken ? {id_token:signedToken(provider)} : {})});
    }
    if (url.href === 'https://api.github.com/user') return Response.json({id:state.subject,login:'fixture',name:'Fixture',email:state.email});
    if (url.href === 'https://api.github.com/user/emails') return Response.json([{email:state.email,primary:true,verified:state.verified}]);
    if (url.hostname === 'discord.com' && decodeURIComponent(url.pathname) === '/api/users/@me') return Response.json({id:'123456789012345678',username:'fixture',global_name:'Fixture',email:state.email,verified:state.verified,avatar:null,discriminator:'0'});
    throw new Error('Unexpected external fixture request. No network access is permitted.');
  };
  const mail = [];
  let identity;
  const create = extra => createIdentity({database,origin,secret:fixtureSecret,registrationMode:'open',
    oauth:readOAuthConfig(env),sendMail:async message=>{mail.push(message);return {status:'accepted'};},...options.identity,...extra});
  identity = create();
  t.after(async()=>{await identity.flushBackgroundTasks();database.close();globalThis.fetch=originalFetch;});
  await(await getMigrations(identity.auth.options)).runMigrations();
  const request = (path,body,cookie,extraHeaders={})=>identity.handle(new Request(origin+'/api/auth'+path,{
    method:body === undefined ? 'GET' : 'POST',headers:{...(body === undefined ? {} : {Origin:origin,'Content-Type':'application/json'}),...(cookie ? {Cookie:cookie} : {}),...extraHeaders},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})
  }),{peerAddress:'127.0.0.1'});
  async function begin(provider,extra={}) {
    const response = await request('/sign-in/social',{provider,callbackURL:'/account',...extra});
    assert.equal(response.status,200);
    const data = await response.json();
    assert.deepEqual(Object.keys(data),['url','redirect']);assert.equal(data.redirect,false);
    const url = new URL(data.url);
    state.nonce=url.searchParams.get('nonce');state.challenge=url.searchParams.get('code_challenge');
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('redirect_uri'),origin+'/api/auth/callback/'+provider);
    assert.ok(!data.url.includes('private-secret'));
    const stateCookie = response.headers.getSetCookie().find(value=>value.includes('.state='));
    assert.ok(stateCookie);assert.match(stateCookie,/HttpOnly/i);assert.match(stateCookie,/SameSite=Lax/i);assert.match(stateCookie,/Secure/i);
    return {url,cookie:cookies(response),provider};
  }
  const callback = (flow,extra={})=>{
    const query = new URLSearchParams({state:flow.url.searchParams.get('state'),code:'fixture-code',...extra});
    return request('/callback/'+flow.provider+'?'+query,undefined,flow.cookie,{'Sec-Fetch-Site':'cross-site'});
  };
  return {database,mail,state,request,begin,callback,replaceIdentity:extra=>{identity=create(extra);return identity;},identity};
}

function assertCallback(response, success) {
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),origin+'/account?oauth='+(success ? 'success' : 'error'));
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
}

test('external provider config requires complete pairs, explicit OIDC opt-in, HTTPS issuer and bounded metadata',()=>{
  assert.deepEqual(readOAuthConfig({}),{social:{},oidc:null});
  const disabled = Object.defineProperty({YUMUNIO_ACCOUNTS_ENABLED:'false'},'YUMUNIO_OAUTH_GOOGLE_CLIENT_SECRET',{get(){throw new Error('Must not read a disabled secret.');}});
  assert.deepEqual(readIdentityConfig(disabled),{enabled:false});
  const oidcDisabled = Object.defineProperty({YUMUNIO_OIDC_ENABLED:'false'},'YUMUNIO_OIDC_CLIENT_SECRET',{get(){throw new Error('Must not read a disabled secret.');}});
  assert.equal(readOAuthConfig(oidcDisabled).oidc,null);
  for (const patch of [
    {YUMUNIO_OAUTH_GOOGLE_CLIENT_ID:'client'}, {YUMUNIO_OAUTH_GITHUB_CLIENT_SECRET:'secret'},
    {YUMUNIO_OIDC_ENABLED:'yes'}, {YUMUNIO_OIDC_ENABLED:'true'},
    {...oauthEnv(),YUMUNIO_OIDC_ISSUER:'http://127.0.0.1'}, {...oauthEnv(),YUMUNIO_OIDC_ISSUER:'https://user:password@id.example'},
    {...oauthEnv(),YUMUNIO_OIDC_ISSUER:'https://id.example?key=value'}, {...oauthEnv(),YUMUNIO_OIDC_CLIENT_SECRET:'bad\nsecret'},
    {...oauthEnv(),YUMUNIO_OIDC_DISPLAY_NAME:'bad\nlabel'}
  ]) assert.throws(()=>readOAuthConfig(patch),/Invalid external identity configuration/);
  assert.throws(()=>validateOAuthConfig({social:{google:{clientId:'client',clientSecret:'secret',getUserInfo(){}}},oidc:null}));
});

test('public config omits credentials/issuer and strict start rejects token shortcuts, caller scopes and open redirects',async t=>{
  const f = await fixture(t);
  const config = await(await f.request('/config')).json();
  assert.deepEqual(config.providers,[{id:'google',label:'Google',type:'oidc'},{id:'github',label:'GitHub',type:'oauth2'},
    {id:'discord',label:'Discord',type:'oauth2'},{id:'oidc',label:'Fixture SSO',type:'oidc'}]);
  assert.equal(config.oauthLinking,false);
  assert.doesNotMatch(JSON.stringify(config),/private-secret|fixture-client|id\.fixture|issuer|clientSecret/);
  for (const extra of [{provider:'unknown'},{callbackURL:'https://evil.invalid'},{callbackURL:'//evil.invalid'},
    {idToken:{token:'forged'}},{scopes:['admin']},{additionalParams:{redirect_uri:'https://evil.invalid'}},{requestSignUp:'yes'}]) {
    assert.equal((await f.request('/sign-in/social',{provider:'google',...extra})).status,400);
  }
  assert.equal((await f.request('/link-social',{provider:'google'})).status,404);
  assert.equal((await f.request('/sign-in/oauth2',{providerId:'oidc'})).status,404);
  const rejected = await f.request('/sign-in/social',{provider:'google'},undefined,{Origin:'https://evil.invalid'});
  assert.equal(rejected.status,403);
  assert.equal((await f.request('/config',undefined,undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
});

for (const provider of ['google','github','discord','oidc']) test(provider+' redirect flow creates only a verified external identity and issues a private session (stub provider)',async t=>{
  const f = await fixture(t);
  const flow = await f.begin(provider);
  if (provider !== 'discord') {assert.equal(flow.url.searchParams.get('code_challenge_method'),'S256');assert.ok(f.state.challenge);}
  if (provider === 'google' || provider === 'oidc') assert.ok(f.state.nonce);
  const completed = await f.callback(flow);
  assertCallback(completed,true);
  const cookie = cookies(completed);assert.ok(cookie);
  assert.ok(completed.headers.getSetCookie().some(value=>value.includes('.session_token=') && /HttpOnly/i.test(value) && /SameSite=Strict/i.test(value)));
  const session = await(await f.request('/get-session',undefined,cookie)).json();
  assert.equal(session.user.email,f.state.email);assert.equal(session.user.emailVerified,true);
  assert.equal(Object.hasOwn(session.session,'token'),false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,1);
  const account = f.database.prepare('SELECT providerId,accountId,accessToken FROM yumunio_auth_accounts').get();
  assert.equal(account.providerId,provider);assert.notEqual(account.accessToken,'fixture-access-token');
  if (provider === 'oidc') {assert.match(account.accountId,/^oidc:[a-f0-9]{64}$/);assert.ok(!account.accountId.includes(f.state.issuer));}
  const beforeReplay = f.state.tokenCalls.length;
  assertCallback(await f.callback(flow),false);
  assert.equal(f.state.tokenCalls.length,beforeReplay);
  assert.equal((await f.request('/sign-out',{},cookie)).status,200);
  assert.equal(await(await f.request('/get-session',undefined,cookie)).json(),null);
});

test('unverified fresh provider emails and blocked registration domains cannot provision users',async t=>{
  const f = await fixture(t,{identity:{domainPolicy:createDomainPolicy({mode:'allowlist',allowedDomains:['studio.example']})}});
  for (const provider of ['google','github','discord','oidc']) {
    f.state.verified=false;
    assertCallback(await f.callback(await f.begin(provider)),false);
  }
  f.state.verified=true;f.state.email='person@blocked.example';
  assertCallback(await f.callback(await f.begin('oidc')),false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_accounts').get().n,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_auth_sessions').get().n,0);
});

test('closed registration allows an existing provider binding but requestSignUp cannot create another identity',async t=>{
  const f = await fixture(t);
  assertCallback(await f.callback(await f.begin('oidc')),true);
  f.replaceIdentity({registrationMode:'closed'});
  assertCallback(await f.callback(await f.begin('oidc')),true);
  f.state.subject='different-subject';f.state.email='new@studio.example';
  assertCallback(await f.callback(await f.begin('oidc',{requestSignUp:true})),false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,1);
});

test('email matches never auto-link a credential account and provider issuer changes cannot reuse a subject binding',async t=>{
  const f = await fixture(t);
  assert.equal((await f.request('/sign-up/email',{name:'Credential',email:f.state.email,password:'credential-fixture-password'})).status,202);
  assertCallback(await f.callback(await f.begin('github')),false);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM yumunio_auth_accounts WHERE providerId <> 'credential'").get().n,0);
  f.state.email='oidc@studio.example';
  assertCallback(await f.callback(await f.begin('oidc')),true);
  f.state.issuer='https://id.fixture.invalid/other';
  f.replaceIdentity({oauth:readOAuthConfig({...oauthEnv(),YUMUNIO_OIDC_ISSUER:f.state.issuer})});
  assertCallback(await f.callback(await f.begin('oidc')),false);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM yumunio_auth_accounts WHERE providerId = 'oidc'").get().n,1);
});

test('OIDC rejects forged signature, issuer, audience, expiry, nonce and missing exp without creating users',async t=>{
  const f = await fixture(t);
  const cases = [
    {invalidSignature:true}, {claims:{iss:'https://evil.invalid'}}, {claims:{aud:'wrong-client'}},
    {claims:{exp:1}}, {claims:{nonce:'wrong-nonce'}}, {claims:{exp:undefined}},
    {claims:{aud:['oidc-fixture-client','another'],azp:'another'}}
  ];
  for (const entry of cases) {
    f.state.invalidSignature=entry.invalidSignature ?? false;f.state.claims=entry.claims ?? {};
    assertCallback(await f.callback(await f.begin('oidc')),false);
  }
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('Google callback verifies a signed ID token and binds nonce instead of merely decoding claims',async t=>{
  const f = await fixture(t);
  f.state.invalidSignature=true;
  assertCallback(await f.callback(await f.begin('google')),false);
  f.state.invalidSignature=false;f.state.claims={nonce:'wrong-nonce'};
  assertCallback(await f.callback(await f.begin('google')),false);
  f.state.claims={aud:'wrong-client'};
  assertCallback(await f.callback(await f.begin('google')),false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('missing/mismatched state or issuer and provider errors never exchange a code or expose raw callback data',async t=>{
  const f = await fixture(t);
  let flow=await f.begin('oidc');
  assertCallback(await f.request('/callback/oidc?code=fixture-code',undefined,flow.cookie,{'Sec-Fetch-Site':'cross-site'}),false);
  assertCallback(await f.callback(flow,{state:'wrong-state'}),false);
  flow=await f.begin('oidc');
  assertCallback(await f.request('/callback/oidc?code=fixture-code&state='+flow.url.searchParams.get('state'),undefined,undefined,{'Sec-Fetch-Site':'cross-site'}),false);
  flow=await f.begin('oidc');
  assertCallback(await f.callback(flow,{iss:'https://evil.invalid'}),false);
  flow=await f.begin('oidc');
  const denied=await f.callback(flow,{error:'provider_private_error',error_description:'private details'});
  assertCallback(denied,false);assert.equal(await denied.text(),'');
  assert.equal(f.state.tokenCalls.length,0);
});

test('malformed or insecure discovery fails only OIDC closed and cannot become an unverified userinfo fallback',async t=>{
  const f=await fixture(t,{state:{metadata:{issuer:'https://wrong.fixture.invalid',authorization_endpoint:'http://127.0.0.1',token_endpoint:'https://id.fixture.invalid/token'}}});
  assert.equal((await f.request('/sign-in/social',{provider:'oidc'})).status,404);
  assert.equal(await(await f.request('/get-session')).json(),null);
  assert.equal(f.state.tokenCalls.length,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('expired database state and missing OIDC ID token fail closed without a userinfo fallback',async t=>{
  const f=await fixture(t);
  let flow=await f.begin('oidc');
  const rows=f.database.prepare('SELECT id,value FROM yumunio_auth_verifications').all();
  assert.equal(rows.length,1);
  const saved=JSON.parse(rows[0].value);saved.expiresAt=Date.now()-1000;
  f.database.prepare('UPDATE yumunio_auth_verifications SET value=? WHERE id=?').run(JSON.stringify(saved),rows[0].id);
  assertCallback(await f.callback(flow),false);
  assert.equal(f.state.tokenCalls.length,0);
  f.state.omitIdToken=true;
  flow=await f.begin('oidc');
  assertCallback(await f.callback(flow),false);
  assert.equal(f.state.tokenCalls.length,1);
  assert.equal(f.state.fetches.some(url=>url.includes('userinfo')),false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('OIDC discovery rejects HTTP metadata endpoints, unsupported signing algorithms and non-S256 PKCE',async t=>{
  const f=await fixture(t);
  const good={issuer:'https://id.fixture.invalid',authorization_endpoint:'https://id.fixture.invalid/authorize',token_endpoint:'https://id.fixture.invalid/token',
    jwks_uri:'https://id.fixture.invalid/jwks',id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']};
  for (const patch of [{jwks_uri:'http://127.0.0.1/keys'},{token_endpoint:'http://127.0.0.1/token'},
    {authorization_endpoint:'http://127.0.0.1/authorize'},{id_token_signing_alg_values_supported:['HS256']},{code_challenge_methods_supported:['plain']}]) {
    f.state.metadata={...good,...patch};
    f.replaceIdentity({});
    assert.equal((await f.request('/sign-in/social',{provider:'oidc'})).status,404);
  }
  assert.equal(f.state.tokenCalls.length,0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('provider token failures cannot leak credentials or provider error details through callback responses or logs',async t=>{
  const f=await fixture(t,{state:{tokenFailure:true}});
  const originalError=console.error;const logged=[];
  console.error=(...args)=>logged.push(args.map(String).join(' '));
  try {
    for (const provider of ['google','github','discord','oidc']) {
      const response=await f.callback(await f.begin(provider));
      assertCallback(response,false);
      assert.equal(await response.text(),'');
    }
  } finally { console.error=originalError; }
  assert.doesNotMatch(logged.join('\n'),/private-fixture|private-provider|private-secret/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM yumunio_users').get().n,0);
});

test('unconfigured providers are omitted rather than exposed as login methods',async t=>{
  const env={YUMUNIO_OIDC_ENABLED:'false'};
  for (const id of ['GOOGLE','GITHUB','DISCORD']) {
    env['YUMUNIO_OAUTH_'+id+'_CLIENT_ID']='';env['YUMUNIO_OAUTH_'+id+'_CLIENT_SECRET']='';
  }
  const f=await fixture(t,{env});
  assert.deepEqual((await(await f.request('/config')).json()).providers,[]);
  assert.equal((await f.request('/sign-in/social',{provider:'google'})).status,400);
  assert.equal(f.state.fetches.length,0);
});

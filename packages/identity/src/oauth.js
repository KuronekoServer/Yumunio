import { genericOAuth } from 'better-auth/plugins';
import { verifyProviderIdToken, verifyJwsAccessToken, validateAuthorizationCode } from 'better-auth/oauth2';

const labels = { google: 'Google', github: 'GitHub', discord: 'Discord' };
const algorithms = ['RS256', 'PS256', 'ES256'];
const invalid = () => { throw new Error('Invalid external identity configuration.'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function credential(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) invalid();
  return value;
}
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) invalid();
  return value;
}
function displayName(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

/** Disabled providers are absent. Secrets are returned only to the private auth factory. */
export function readOAuthConfig(env = {}) {
  const social = {};
  for (const id of Object.keys(labels)) {
    const prefix = 'YUMUNIO_OAUTH_' + id.toUpperCase();
    const clientId = env[prefix + '_CLIENT_ID'] || '';
    const clientSecret = env[prefix + '_CLIENT_SECRET'] || '';
    if (!clientId && !clientSecret) continue;
    social[id] = { clientId: credential(clientId), clientSecret: credential(clientSecret) };
  }
  const enabled = env.YUMUNIO_OIDC_ENABLED;
  if (![undefined, '', 'false', 'true'].includes(enabled)) invalid();
  let oidc = null;
  if (enabled === 'true') oidc = {
    issuer: httpsUrl(env.YUMUNIO_OIDC_ISSUER), clientId: credential(env.YUMUNIO_OIDC_CLIENT_ID),
    clientSecret: credential(env.YUMUNIO_OIDC_CLIENT_SECRET), label: displayName(env.YUMUNIO_OIDC_DISPLAY_NAME || '\u7d44\u7e54\u306eSSO')
  };
  return { social, oidc };
}

export function validateOAuthConfig(config = { social: {}, oidc: null }) {
  if (!plain(config) || Object.keys(config).some(key => !['social', 'oidc'].includes(key)) || !plain(config.social) ||
      Object.keys(config.social).some(id => !Object.hasOwn(labels, id))) invalid();
  const social = {};
  for (const [id, value] of Object.entries(config.social)) {
    if (!plain(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'clientId') || !Object.hasOwn(value, 'clientSecret')) invalid();
    social[id] = { clientId: credential(value.clientId), clientSecret: credential(value.clientSecret) };
  }
  let oidc = null;
  if (config.oidc !== null) {
    const value = config.oidc;
    if (!plain(value) || Object.keys(value).length !== 4 || !['issuer','clientId','clientSecret','label'].every(key => Object.hasOwn(value,key))) invalid();
    oidc = { issuer: httpsUrl(value.issuer), clientId: credential(value.clientId), clientSecret: credential(value.clientSecret), label: displayName(value.label) };
  }
  return { social, oidc };
}

async function fetchJson(fetcher, url) {
  const response = await fetcher(url, { headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) throw new Error('External identity metadata is unavailable.');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { try { await reader.cancel(); } catch {} throw new Error('Invalid external identity metadata.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function validateDiscovery(value, oidc) {
  if (!plain(value) || value.issuer !== oidc.issuer || !Array.isArray(value.id_token_signing_alg_values_supported)) invalid();
  const supported = algorithms.filter(alg => value.id_token_signing_alg_values_supported.includes(alg));
  if (!supported.length || (value.code_challenge_methods_supported && !value.code_challenge_methods_supported.includes('S256'))) invalid();
  return { authorization: httpsUrl(value.authorization_endpoint), token: httpsUrl(value.token_endpoint),
    jwks: httpsUrl(value.jwks_uri), algorithms: supported };
}
async function oidcSubject(issuer, subject) {
  if (typeof subject !== 'string' || !subject || subject.length > 1024 || /[\u0000-\u001f\u007f]/.test(subject)) throw new Error('Invalid external identity subject.');
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(issuer + '\0' + subject));
  return 'oidc:' + Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/**
 * SDK genericOAuth owns code exchange and PKCE; the application validates trusted
 * discovery first and verifies ID tokens with the SDK's public JOSE verifier.
 * No userinfo fallback or direct browser-submitted ID-token sign-in is exposed.
 */
export function createOAuthSetup(input, { registrationMode = 'closed', fetch: fetcher = globalThis.fetch } = {}) {
  const config = validateOAuthConfig(input);
  if (!['closed','open'].includes(registrationMode) || typeof fetcher !== 'function') invalid();
  const providers = Object.keys(labels).filter(id=>config.social[id]).map(id=>({ id,label:labels[id],type:id === 'google' ? 'oidc' : 'oauth2' }));
  if (config.oidc) providers.push({ id:'oidc',label:config.oidc.label,type:'oidc' });
  const socialProviders = Object.fromEntries(Object.entries(config.social).map(([id,value])=>[id,{
    ...value,disableSignUp:registrationMode !== 'open',requireEmailVerification:true,
    ...(id === 'google' ? { prompt:'select_account',includeGrantedScopes:false } : id === 'discord' ? { prompt:'consent' } : {})
  }]));
  if (!providers.length) return { providers,socialProviders,plugins:[] };
  const plugin = { id:'yumunio-external-identity', async init(context) {
    let registered = [...context.socialProviders];
    if (config.oidc) {
      try {
        const oidc = config.oidc;
        const metadata = validateDiscovery(await fetchJson(fetcher,oidc.issuer.replace(/\/$/,'')+'/.well-known/openid-configuration'),oidc);
        const inner = genericOAuth({config:[{ providerId:'oidc',name:oidc.label,clientId:oidc.clientId,clientSecret:oidc.clientSecret,
          authorizationUrl:metadata.authorization,tokenUrl:metadata.token,scopes:['openid','email','profile'],
          pkce:true,responseType:'code',responseMode:'query',disableSignUp:registrationMode !== 'open',
          requireEmailVerification:true,disableProviderLogout:true }]});
        const initialized = await inner.init({...context,socialProviders:registered});
        registered = initialized.context.socialProviders;
        const provider = registered.find(item=>item.id === 'oidc');
        if (!provider) throw new Error('External identity provider is unavailable.');
        provider.issuer = oidc.issuer;
        provider.requiresIdTokenNonce = true;
        provider.accountSubject = ({profile})=>oidcSubject(oidc.issuer,profile.sub);
        const cacheKey = {};
        provider.getUserInfo = async tokens => {
          if (typeof tokens.idToken !== 'string' || typeof tokens.expectedIdTokenNonce !== 'string' || !tokens.expectedIdTokenNonce) return null;
          try {
            const claims = await verifyJwsAccessToken(tokens.idToken,{
              jwksFetch:()=>fetchJson(fetcher,metadata.jwks),jwksCacheKey:cacheKey,
              verifyOptions:{issuer:oidc.issuer,audience:oidc.clientId,algorithms:metadata.algorithms,
                requiredClaims:['iss','sub','aud','exp','iat','nonce'],maxTokenAge:'1h',clockTolerance:30}
            });
            if (claims.nonce !== tokens.expectedIdTokenNonce || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== oidc.clientId) ||
                (claims.azp !== undefined && claims.azp !== oidc.clientId)) return null;
            await oidcSubject(oidc.issuer,claims.sub);
            return { user:{name:typeof claims.name === 'string' ? claims.name : '',email:claims.email,emailVerified:claims.email_verified === true},data:claims };
          } catch { return null; }
        };
      } catch {
        // Fail this provider closed without taking password authentication offline.
        registered = registered.filter(provider=>provider.id !== 'oidc');
      }
    }
    const google = registered.find(provider=>provider.id === 'google');
    if (google) {
      const getUserInfo = google.getUserInfo.bind(google);
      google.requiresIdTokenNonce = true;
      google.idToken = {...google.idToken,algorithms:['RS256']};
      google.getUserInfo = async tokens => {
        if (typeof tokens.idToken !== 'string' || typeof tokens.expectedIdTokenNonce !== 'string' || !tokens.expectedIdTokenNonce ||
            !await verifyProviderIdToken(google,tokens.idToken,tokens.expectedIdTokenNonce)) return null;
        const result = await getUserInfo(tokens);
        if (!result?.data || typeof result.data.exp !== 'number' || typeof result.data.iat !== 'number' ||
            typeof result.data.sub !== 'string' || !result.data.sub ||
            (Array.isArray(result.data.aud) && result.data.aud.length > 1 && result.data.azp !== config.social.google.clientId) ||
            (result.data.azp !== undefined && result.data.azp !== config.social.google.clientId)) return null;
        return result;
      };
    }
    const github = registered.find(provider=>provider.id === 'github');
    if (github) github.validateAuthorizationCode = data=>validateAuthorizationCode({
      ...data,options:config.social.github,tokenEndpoint:'https://github.com/login/oauth/access_token'
    });
    for (const provider of registered) {
      const getUserInfo = provider.getUserInfo.bind(provider);
      provider.getUserInfo = async tokens => { try { return await getUserInfo(tokens); } catch { return null; } };
    }
    for (const provider of registered) if (provider.id === 'google' || provider.id === 'oidc') {
      const createAuthorizationURL = provider.createAuthorizationURL.bind(provider);
      provider.createAuthorizationURL = async data => {
        if (!data.idTokenNonce) throw new Error('External identity nonce is required.');
        const url = new URL(await createAuthorizationURL(data));
        url.searchParams.set('nonce',data.idTokenNonce);
        return url;
      };
    }
    return {context:{socialProviders:registered}};
  } };
  return { providers,socialProviders,plugins:[plugin] };
}

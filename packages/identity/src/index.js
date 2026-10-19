import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { createOAuthSetup } from './oauth.js';
import { createDomainPolicy, isEmailAllowed } from './config.js';
export { readIdentityConfig, createDomainPolicy, isEmailAllowed, normalizeDomain } from './config.js';

const MAX_AUTH_BYTES = 16384;
const publicPaths = new Set([
  '/sign-up/email', '/sign-in/email', '/sign-out', '/get-session', '/verify-email',
  '/send-verification-email', '/request-password-reset', '/reset-password',
  '/revoke-sessions',
  '/organization/create', '/organization/list', '/organization/set-active'
]);
const mailRequestPaths = new Set(['/sign-up/email', '/send-verification-email', '/request-password-reset']);
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...responseHeaders, ...headers } });
export const disabledIdentityResponse = () => reply({ enabled: false, registrationMode: 'closed', emailDelivery: false, workspaceContent: false, providers: [], oauthLinking: false });

async function boundedRequest(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_AUTH_BYTES)) return null;
  if (!request.body) return request;
  const reader = request.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUTH_BYTES) { try { await reader.cancel(); } catch {} return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}

/** Account identity only. Workspace notes and page grants stay outside this auth database API. */
export function createIdentity({ database, origin, secret, registrationMode = 'closed', domainPolicy = createDomainPolicy(), sendMail, enqueueMail, backgroundTask, workspaceContent = false, oauth } = {}) {
  if (!database || typeof origin !== 'string' || new URL(origin).origin !== origin ||
      typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 ||
      !['closed', 'open'].includes(registrationMode) || (sendMail !== undefined && typeof sendMail !== 'function') || (enqueueMail !== undefined && typeof enqueueMail !== 'function') ||
      (backgroundTask !== undefined && typeof backgroundTask !== 'function') ||
      (registrationMode === 'open' && !sendMail && !enqueueMail)) throw new Error('Invalid identity options; open registration requires email delivery.');
  const domain = createDomainPolicy(domainPolicy);
  const external = createOAuthSetup(oauth, { registrationMode });
  const providerIds = new Set(external.providers.map(provider => provider.id));
  const pendingMail = new Set();
  const send = async (user, token, purpose) => {
    if (!sendMail && !enqueueMail) return;
    const to = user.email;
    const makeMessage = () => {
      const link = new URL('/account', origin); link.searchParams.set(purpose, token);
      return { to, subject: purpose === 'verify' ? 'Yumunio: メールアドレスの確認' : 'Yumunio: パスワードの再設定', text: '本人が操作を続ける場合だけ、次の画面で確認してください。\n' + link.href };
    };
    if (enqueueMail) {
      const queued = await enqueueMail(makeMessage(), { expiresAt: new Date(Date.now() + (purpose === 'verify' ? 3600000 : 1800000)).toISOString() });
      if (queued?.status !== 'queued') throw new Error('Durable email enqueue was not confirmed.');
      return;
    }
    const task = Promise.resolve().then(async () => {
      const link = new URL('/account', origin);
      link.searchParams.set(purpose, token);
      const result = await sendMail({ to, subject: purpose === 'verify' ? 'Yumunio: メールアドレスの確認' : 'Yumunio: パスワードの再設定', text: '本人が操作を続ける場合だけ、次の画面で確認してください。\n' + link.href });
      if (result?.status !== 'accepted') throw new Error('Email submission was not accepted.');
    }).catch(() => {}).finally(() => { pendingMail.delete(task); });
    pendingMail.add(task);
    if (backgroundTask) {
      try {
        const scheduled = backgroundTask(task);
        if (scheduled instanceof Promise) scheduled.catch(() => {});
      } catch {}
    }
  };
  const auth = betterAuth({
    appName: 'Yumunio', baseURL: origin, basePath: '/api/auth', secret, database,
    trustedOrigins: [origin], logger: { disabled: true },
    socialProviders: external.socialProviders,
    onAPIError: { errorURL: origin + '/account?oauth=error' },
    emailAndPassword: {
      enabled: true, disableSignUp: registrationMode !== 'open', requireEmailVerification: true,
      minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false,
      revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 1800,
      sendResetPassword: ({ user, token }) => send(user, token, 'reset')
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: ({ user, token }) => send(user, token, 'verify'),
      beforeEmailVerification: async user => { if (!isEmailAllowed(user.email, domain)) throw new APIError('FORBIDDEN', { message: 'Registration is not available.' }); }
    },
    session: { modelName: 'yumunio_auth_sessions', expiresIn: 28800, updateAge: 3600, cookieCache: { enabled: false } },
    verification: { modelName: 'yumunio_auth_verifications', storeIdentifier: 'hashed' },
    user: { modelName: 'yumunio_users', validateUserInfo: ({ user, source }) => {
      if (source.method !== 'oauth') return;
      if (user.emailVerified !== true || !isEmailAllowed(user.email, domain) || source.action === 'link-account' ||
          (source.action === 'create-user' && registrationMode !== 'open')) {
        return { error: 'external_identity_rejected', errorDescription: 'The external identity could not be used.' };
      }
    } },
    account: { modelName: 'yumunio_auth_accounts', encryptOAuthTokens: true, storeStateStrategy: 'database', skipStateCookieCheck: false, accountLinking: { enabled: false, disableImplicitLinking: true } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60, modelName: 'yumunio_auth_rate_limits',
      customRules: { '/sign-in/social': { window: 60, max: 10 }, '/sign-in/email': { window: 60, max: 5 }, '/sign-up/email': { window: 60, max: 3 }, '/request-password-reset': { window: 60, max: 3 }, '/send-verification-email': { window: 60, max: 3 } } },
    advanced: {
      cookiePrefix: 'yumunio.account', defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', secure: origin.startsWith('https:'), path: '/' },
      cookies: { state: { attributes: { sameSite: 'lax' } }, oauth_state: { attributes: { sameSite: 'lax' } } },
      ipAddress: { ipAddressHeaders: ['x-yumunio-peer-ip'] },
      // Durable enqueue must finish before SDK mail callbacks return, even on Workers.
      ...(backgroundTask && !enqueueMail ? { backgroundTasks: { handler: backgroundTask } } : {})
    },
    databaseHooks: { user: { create: { before: async user => {
      if (registrationMode !== 'open' || !isEmailAllowed(user.email, domain)) throw new APIError('FORBIDDEN', { message: 'Registration is not available.' });
      return { data: user };
    } } } },
    plugins: [...external.plugins, organization({ allowUserToCreateOrganization: async user => user.emailVerified === true,
      organizationLimit: 100, membershipLimit: 1000,
      schema: { organization: { modelName: 'yumunio_workspaces' }, member: { modelName: 'yumunio_memberships' }, invitation: { modelName: 'yumunio_workspace_invitations' } } })]
  });
  return {
    auth,
    apiTokens: null,
    /** In-memory drain only: no durable outbox, delivery result, retry, or restart guarantee. */
    async flushBackgroundTasks() {
      while (pendingMail.size) await Promise.all([...pendingMail]);
    },
    async handle(request, { peerAddress = 'unknown' } = {}) {
      const url = new URL(request.url);
      const path = url.pathname.slice('/api/auth'.length);
      const callback = /^\/callback\/(google|github|discord|oidc)$/.exec(path);
      const isCallback = Boolean(callback && providerIds.has(callback[1]) && request.method === 'GET');
      const socialStart = path === '/sign-in/social' && request.method === 'POST';
      if (url.origin !== origin || (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
          (!isCallback && !['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site'))) ||
          (request.method === 'POST' && request.headers.get('origin') !== origin)) return reply({ error: { code: 'ORIGIN_REJECTED', message: 'This origin is not allowed.' } }, 403);
      if (path === '/config' && request.method === 'GET') return reply({ enabled: true, registrationMode, emailDelivery: Boolean(sendMail || enqueueMail), workspaceContent: Boolean(workspaceContent), providers: external.providers.map(provider => ({...provider})), oauthLinking: false });
      if (!publicPaths.has(path) && !isCallback && !socialStart) return reply({ error: { code: 'NOT_IMPLEMENTED', message: 'This account operation is not available.' } }, 404);
      if (isCallback && url.search.length > MAX_AUTH_BYTES) return reply({ error: { code: 'ACCOUNT_REQUEST_FAILED', message: 'The account request could not be completed.' } }, 400);
      if (!['GET', 'POST'].includes(request.method)) return reply({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } }, 405);
      try {
        let bounded = request.method === 'POST' ? await boundedRequest(request) : request;
        if (!bounded) return reply({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Account request is too large.' } }, 413);
        if (path.startsWith('/organization/') && bounded.headers.has('X-Yumunio-Expected-Account')) {
          const expected = bounded.headers.get('X-Yumunio-Expected-Account');
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expected || '')) return reply({ error: { code: 'INVALID_ACCOUNT_REQUEST', message: 'Invalid account request.' } }, 400);
          // The SDK receives the same captured Cookie headers after this check.
          // A later browser account switch cannot change this request's actor.
          const session = await auth.api.getSession({ headers: bounded.headers });
          if (!session?.user) return reply({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in to continue.' } }, 401);
          if (session.user.id !== expected) return reply({ error: { code: 'ACCOUNT_CHANGED', message: 'The active account changed.' } }, 409);
          if (session.user.emailVerified !== true) return reply({ error: { code: 'VERIFY_EMAIL', message: 'Verify your email to continue.' } }, 403);
        }
        if (socialStart) {
          let data;
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(bounded.headers.get('content-type') || '')) throw new Error();
            data = await bounded.json();
            if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['provider','callbackURL','requestSignUp'].includes(key)) ||
                !providerIds.has(data.provider) || (data.callbackURL !== undefined && data.callbackURL !== '/account') ||
                (data.requestSignUp !== undefined && typeof data.requestSignUp !== 'boolean')) throw new Error();
          } catch { return reply({ error: { code: 'INVALID_ACCOUNT_REQUEST', message: 'Invalid external sign-in request.' } }, 400); }
          bounded = new Request(bounded.url, { method:'POST', headers:bounded.headers, body:JSON.stringify({provider:data.provider,
            callbackURL:origin+'/account',newUserCallbackURL:origin+'/account',errorCallbackURL:origin+'/account?oauth=error',
            disableRedirect:true,...(data.requestSignUp === undefined ? {} : {requestSignUp:data.requestSignUp})}) });
        }
        const headers = new Headers(bounded.headers);
        headers.set('x-yumunio-peer-ip', String(peerAddress).slice(0, 128));
        const internal = new Request(bounded, { headers });
        const result = await auth.handler(internal);
        const safeHeaders = new Headers(result.headers);
        for (const [name, value] of Object.entries(responseHeaders)) safeHeaders.set(name, value);
        if (isCallback) {
          let target;
          try { target = new URL(result.headers.get('location'),origin); } catch {}
          const success = result.status >= 300 && result.status < 400 && target?.origin === origin &&
            target.pathname === '/account' && !target.searchParams.has('error') && !target.searchParams.has('oauth');
          safeHeaders.delete('content-length'); safeHeaders.delete('content-type');
          safeHeaders.set('location',origin+'/account?oauth='+(success ? 'success' : 'error'));
          return new Response(null,{status:302,headers:safeHeaders});
        }
        if (result.status >= 400) {
          const status = result.status === 429 ? 429 : path === '/sign-in/email' ? 401 : result.status >= 500 ? 503 : result.status;
          safeHeaders.delete('content-length'); safeHeaders.set('content-type', 'application/json; charset=utf-8');
          return new Response(JSON.stringify({ error: { code: status === 429 ? 'RATE_LIMITED' : 'ACCOUNT_REQUEST_FAILED', message: status === 429 ? 'Please wait before retrying.' : 'The account request could not be completed.' } }), { status, headers: safeHeaders });
        }
        if (socialStart && result.ok) {
          const data = await result.json(); const destination = new URL(data.url);
          if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('Invalid external sign-in destination.');
          safeHeaders.delete('content-length'); safeHeaders.delete('location');
          safeHeaders.set('content-type','application/json; charset=utf-8');
          return new Response(JSON.stringify({url:destination.href,redirect:false}),{status:200,headers:safeHeaders});
        }
        if (result.ok && (path === '/sign-in/email' || path === '/get-session')) {
          const data = await result.json();
          const user = data?.user ? { id: data.user.id, name: data.user.name, email: data.user.email, emailVerified: data.user.emailVerified === true } : null;
          if (path === '/sign-in/email' && !user) throw new Error('Invalid sign-in result.');
          const output = path === '/sign-in/email' ? { authenticated: true, user } :
            user ? { user, session: { id: data.session?.id, expiresAt: data.session?.expiresAt } } : null;
          safeHeaders.delete('content-length');
          safeHeaders.set('content-type', 'application/json; charset=utf-8');
          return new Response(JSON.stringify(output), { status: result.status, headers: safeHeaders });
        }
        if (mailRequestPaths.has(path) && result.ok) return reply({ status: 'request-received' }, 202);
        if (path === '/verify-email' && result.status >= 300 && result.status < 400) {
          let target;
          try { target = new URL(result.headers.get('location'), origin); } catch {}
          if (!target || target.origin !== origin || target.searchParams.has('error')) return reply({ error: { code: 'ACCOUNT_REQUEST_FAILED', message: 'The confirmation link could not be used.' } }, 400);
          return reply({ status: 'email-verified' });
        }
        return new Response(result.body, { status: result.status, headers: safeHeaders });
      } catch { return reply({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'The account service is unavailable.' } }, 503); }
    }
  };
}

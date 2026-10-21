import { hashPassword } from 'better-auth/crypto';
import { readIdentityConfig } from './config.js';
import { readMailConfig, validateMailMessage } from './mail.js';
import { readServerAdminIds } from './admin.js';
import {canonicalLocale} from './locale-code.js';
import { validatePublicOrigin, isValidAccessKey } from '../../prototype/src/config.js';

const encoder = new TextEncoder();
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };
const json = (body, status = 200) => Response.json(body, { status, headers });
const fail = (code, status = 400) => { throw Object.assign(new Error('Unable to complete instance setup.'), { code, status }); };
export const SETUP_FIELDS = Object.freeze([
  'YUMUNIO_BRAND_NAME', 'YUMUNIO_BRAND_ORGANIZATION', 'YUMUNIO_DEFAULT_LOCALE', 'YUMUNIO_DEFAULT_THEME',
  'YUMUNIO_REGISTRATION_MODE', 'YUMUNIO_EMAIL_DOMAIN_MODE', 'YUMUNIO_EMAIL_ALLOWED_DOMAINS', 'YUMUNIO_EMAIL_BLOCKED_DOMAINS',
  'YUMUNIO_EMAIL_ALLOW_SUBDOMAINS', 'YUMUNIO_EMAIL_BLOCK_SUBDOMAINS',
  'YUMUNIO_MAIL_DRIVER', 'YUMUNIO_SMTP_FROM', 'YUMUNIO_SMTP_REPLY_TO', 'YUMUNIO_SMTP_HOST', 'YUMUNIO_SMTP_PORT', 'YUMUNIO_SMTP_TLS', 'YUMUNIO_SMTP_USER', 'YUMUNIO_SMTP_PASSWORD', 'YUMUNIO_MAIL_HTTP_ENDPOINT', 'YUMUNIO_MAIL_HTTP_TOKEN',
  ...['GOOGLE', 'GITHUB', 'DISCORD'].flatMap(provider => ['YUMUNIO_OAUTH_' + provider + '_CLIENT_ID', 'YUMUNIO_OAUTH_' + provider + '_CLIENT_SECRET']),
  'YUMUNIO_OIDC_ENABLED', 'YUMUNIO_OIDC_DISPLAY_NAME', 'YUMUNIO_OIDC_ISSUER', 'YUMUNIO_OIDC_CLIENT_ID', 'YUMUNIO_OIDC_CLIENT_SECRET'
]);
export const SETUP_SECRET_FIELDS = Object.freeze(SETUP_FIELDS.filter(key => /(?:PASSWORD|TOKEN|SECRET)$/.test(key)));
const defaults = { YUMUNIO_BRAND_NAME: 'Yumunio', YUMUNIO_DEFAULT_LOCALE: 'ja', YUMUNIO_DEFAULT_THEME: 'light', YUMUNIO_REGISTRATION_MODE: 'closed', YUMUNIO_MAIL_DRIVER: 'disabled', YUMUNIO_SMTP_PORT: '587', YUMUNIO_SMTP_TLS: 'starttls_required', YUMUNIO_EMAIL_DOMAIN_MODE: 'unrestricted', YUMUNIO_EMAIL_ALLOW_SUBDOMAINS: 'false', YUMUNIO_EMAIL_BLOCK_SUBDOMAINS: 'true', YUMUNIO_OIDC_ENABLED: 'false' };
const hex = bytes => Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unbase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export async function initialSetupAuthorization(env) {
  return env.YUMUNIO_SETUP_TOKEN || hex(await digest('yumunio/bootstrap/v1\0' + env.YUMUNIO_INSTANCE_SECRET));
}
export async function initialSetupUrl(env, origin) {
  return origin + '/setup#start=' + encodeURIComponent(await initialSetupAuthorization(env));
}

/** One operator-held key protects persisted credentials and derives stable auth keys. */
export async function createInstanceSetup({ env, store, origin, runtime = 'node', resolveSession = async () => null, assertReady = async () => {} }) {
  const token = env.YUMUNIO_INSTANCE_SECRET || env.YUMUNIO_SETUP_TOKEN;
  if (!isValidAccessKey(token) || token !== token.trim()) throw new Error('Instance credentials are unavailable.');
  const authorization = await initialSetupAuthorization(env);
  const secret = hex(await digest('yumunio/auth/v1\0' + token));
  const access = hex(await digest('yumunio/snapshot/v1\0' + token));
  const key = await crypto.subtle.importKey('raw', await digest('yumunio/settings/v1\0' + token), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const seal = async value => { const iv = crypto.getRandomValues(new Uint8Array(12)); return base64(iv) + '.' + base64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('yumunio-instance-v1') }, key, encoder.encode(JSON.stringify(value)))); };
  const open = async sealed => { const [iv, data] = sealed.split('.'); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode('yumunio-instance-v1') }, key, unbase64(data)))); };
  let originSnapshot;
  if (!origin && !env.YUMUNIO_PUBLIC_ORIGIN) {
    const row = await store.read();
    const data = row ? await open(row.sealed) : null;
    originSnapshot = { row, data };
    origin = data?.origin || 'https://setup.invalid';
  }
  origin = validatePublicOrigin(env.YUMUNIO_PUBLIC_ORIGIN || origin);
  if (!origin.startsWith('https:') && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Setup requires HTTPS or loopback.');
  const base = { ...env, YUMUNIO_ACCESS_KEY: env.YUMUNIO_ACCESS_KEY || access, YUMUNIO_AUTH_SECRET: env.YUMUNIO_AUTH_SECRET || secret, YUMUNIO_PUBLIC_ORIGIN: origin };
  const settingsDefaults = Object.fromEntries(SETUP_FIELDS.map(field => [field, env[field] || defaults[field] || '']));
  const effective = data => ({ ...base, ...data?.settings, YUMUNIO_ACCOUNTS_ENABLED: data ? 'true' : 'false', YUMUNIO_SERVER_ADMIN_IDS: [...new Set([...readServerAdminIds(env), ...(data ? [data.adminId] : [])])].join(',') });
  const load = async () => {
    // Origin inference and the first load belong to one configuration read.
    // Consume it once; later loads always observe persisted settings again.
    const snapshot = originSnapshot;
    originSnapshot = undefined;
    const row = snapshot ? snapshot.row : await store.read();
    const data = snapshot ? snapshot.data : row ? await open(row.sealed) : null;
    if (data && (data.origin !== origin || !/^[A-Za-z0-9._:-]{1,128}$/.test(data.adminId))) throw new Error('Stored instance configuration does not match this deployment.');
    return { revision: row ? Number(row.revision) : 0, data, env: effective(data) };
  };
  function validateSettings(input, previous = settingsDefaults) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(field => !SETUP_FIELDS.includes(field))) fail('SETUP_INVALID_SETTINGS');
    const values = { ...previous };
    for (const [field, value] of Object.entries(input)) {
      if (value === null && SETUP_SECRET_FIELDS.includes(field)) { values[field] = ''; continue; }
      if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) fail('SETUP_INVALID_SETTINGS');
      if (!SETUP_SECRET_FIELDS.includes(field) || value !== '') values[field] = value;
    }
    if (!values.YUMUNIO_BRAND_NAME.trim() || values.YUMUNIO_BRAND_NAME.length > 80 || values.YUMUNIO_BRAND_ORGANIZATION.length > 120 || /[\u0000-\u001f\u007f]/.test(values.YUMUNIO_BRAND_NAME + values.YUMUNIO_BRAND_ORGANIZATION) || !['paper', 'light', 'ocean', 'lavender', 'forest', 'midnight'].includes(values.YUMUNIO_DEFAULT_THEME)) fail('SETUP_INVALID_SETTINGS');
    try {
      values.YUMUNIO_DEFAULT_LOCALE=canonicalLocale(values.YUMUNIO_DEFAULT_LOCALE);
      const candidate = { ...base, ...values, YUMUNIO_ACCOUNTS_ENABLED: 'true' };
      const identity = readIdentityConfig(candidate), mail = readMailConfig(candidate);
      if (mail.driver === 'cloudflare' && (runtime !== 'worker' || typeof env.EMAIL?.send !== 'function')) fail('SETUP_CLOUDFLARE_EMAIL_REQUIRED');
      if (runtime === 'worker' && mail.driver === 'smtp' && mail.port === 25) fail('SETUP_SMTP_PORT');
      if (identity.registrationMode === 'open' && mail.driver === 'disabled') fail('SETUP_MAIL_REQUIRED');
    } catch (error) { if (['SETUP_MAIL_REQUIRED','SETUP_CLOUDFLARE_EMAIL_REQUIRED','SETUP_SMTP_PORT'].includes(error.code)) throw error; fail('SETUP_INVALID_SETTINGS'); }
    return values;
  }
  async function readJson(request) {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail('SETUP_CONTENT_TYPE', 415);
    const reader = request.body?.getReader(); if (!reader) fail('SETUP_INVALID_REQUEST');
    const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); fail('SETUP_TOO_LARGE', 413); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('SETUP_INVALID_REQUEST'); }
  }
  const projection = settings => ({ settings: Object.fromEntries(SETUP_FIELDS.filter(field => !SETUP_SECRET_FIELDS.includes(field)).map(field => [field, settings[field] || ''])), secrets: Object.fromEntries(SETUP_SECRET_FIELDS.map(field => [field, Boolean(settings[field])])), runtime,mailCapabilities:{cloudflare:runtime==='worker'&&typeof env.EMAIL?.send==='function',smtp:true} });
  return { load, baseEnvironment: base, initialSetupUrl: await initialSetupUrl(env, origin),
    async handle(request) {
      try {
        const url = new URL(request.url), write = request.method !== 'GET';
        if (url.origin !== origin || url.search || url.hash || request.headers.has('origin') && request.headers.get('origin') !== origin || write && request.headers.get('origin') !== origin || !['same-origin', 'none', null].includes(request.headers.get('sec-fetch-site'))) fail('SETUP_ORIGIN_REJECTED', 403);
        const state = await load();
        if (url.pathname === '/api/setup' && request.method === 'GET') return json({ enabled: true, required: !state.data, runtime });
        if (url.pathname === '/api/setup' && request.method === 'POST') {
          if (state.data) fail('SETUP_COMPLETE', 409);
          const supplied = request.headers.get('x-yumunio-setup-token') || '';
          const expectedBytes = new Uint8Array(await digest(authorization)), actualBytes = new Uint8Array(await digest(supplied));
          let mismatch = 0; for (let i = 0; i < expectedBytes.length; i++) mismatch |= expectedBytes[i] ^ actualBytes[i];
          if (mismatch) fail('SETUP_TOKEN_REJECTED', 403);
          await assertReady();
          if (!await store.fresh()) fail('SETUP_EXISTING_INSTANCE', 409);
          const input = await readJson(request);
          if (!input || Object.keys(input).some(key => !['name', 'email', 'password', 'settings'].includes(key)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f\u007f]/.test(input.name) || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128 || input.password.includes('\0')) fail('SETUP_INVALID_OWNER');
          let email; try { email = validateMailMessage({ to: input.email, subject: 'Setup', text: 'Setup' }).to.toLowerCase(); } catch { fail('SETUP_INVALID_OWNER'); }
          const settings = validateSettings(input.settings || {}), owner = { id: crypto.randomUUID(), name: input.name.trim(), email };
          const sealed = await seal({ origin, adminId: owner.id, settings });
          await store.initialize({ sealed, owner, passwordHash: await hashPassword(input.password), workspaceName: settings.YUMUNIO_BRAND_NAME });
          return json({ complete: true, signIn: '/account' }, 201);
        }
        if (url.pathname !== '/api/admin/settings' || !state.data) fail('SETUP_NOT_FOUND', 404);
        await assertReady();
        const session = await resolveSession(request), actor = session?.user;
        if (!actor || actor.emailVerified !== true || !readServerAdminIds(state.env).includes(actor.id) || write && request.headers.get('x-yumunio-expected-account') !== actor.id) fail('SETUP_NOT_FOUND', 404);
        if (request.method === 'GET') return json({ ...projection(state.data.settings), revision: state.revision });
        if (request.method === 'PUT') {
          const input = await readJson(request);
          if (!input || Object.keys(input).some(key => !['revision', 'settings'].includes(key)) || input.revision !== state.revision) fail('SETUP_CONFLICT', 409);
          const settings = validateSettings(input.settings, state.data.settings);
          await store.update(state.revision, await seal({ ...state.data, settings }));
          return json({ saved: true, revision: state.revision + 1 });
        }
        fail('SETUP_METHOD_NOT_ALLOWED', 405);
      } catch (error) { return json({ error: { code: error.status ? error.code : 'SETUP_UNAVAILABLE' } }, error.status || 503); }
    }
  };
}

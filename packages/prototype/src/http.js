import { MAX_BODY_BYTES, SnapshotError, validateSnapshot } from './snapshot.js';
import { isValidAccessKey, validatePublicOrigin } from './config.js';
import { buildWorkspaceExport } from './export.js';

const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra } });
const error = (code, message, status, details) => json({ error: { code, message, ...(details ? { details } : {}) } }, status);
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
const cookieName = 'yumunio_session';
const ttl = 8 * 60 * 60;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Bound the streamed body as well as Content-Length; never parse unbounded JSON. */
async function bodyJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new SnapshotError('CONTENT_TYPE', 'Use application/json.', 415);
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new SnapshotError('PAYLOAD_TOO_LARGE', 'Request body exceeds the prototype size limit.', 413);
  if (!request.body) throw new SnapshotError('INVALID_JSON', 'Expected a JSON body.');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { try { await reader.cancel(); } catch { /* Keep the known size error. */ } throw new SnapshotError('PAYLOAD_TOO_LARGE', 'Request body exceeds the prototype size limit.', 413); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    if (cause instanceof SnapshotError) throw cause;
    throw new SnapshotError('INVALID_JSON', 'Invalid JSON body.');
  } finally { reader.releaseLock(); }
}

/**
 * Shared single-user snapshot API. No user accounts, roles, or collaborative sync.
 * Anonymous mode is only for an explicitly trusted loopback Node host.
 */
export function createWorkspaceApi({ store = null, storage = 'browser-local', accessKey = '', allowAnonymous = false, origin, now = () => Date.now() } = {}) {
  const expectedOrigin = validatePublicOrigin(origin);
  if (accessKey && !isValidAccessKey(accessKey)) throw new Error('Use an access key of 32 to 4096 characters.');
  const loopbackOrigin = ['127.0.0.1', 'localhost'].includes(new URL(expectedOrigin).hostname);
  if (store && !accessKey && (!allowAnonymous || !loopbackOrigin)) throw new Error('Server persistence requires an access key outside loopback mode.');
  const secure = expectedOrigin.startsWith('https:');
  let signingKey, expectedHash;
  const encoder = new TextEncoder();
  const key = () => signingKey ??= crypto.subtle.importKey('raw', encoder.encode(accessKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const cookieHeader = (value, age = ttl) => cookieName + '=' + value + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + age + (secure ? '; Secure' : '');
  async function authenticated(request) {
    if (!accessKey) return allowAnonymous;
    const cookie = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
    if (!cookie) return false;
    const token = cookie.slice(cookieName.length + 1);
    const match = /^v1\.(\d{11,14})\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return false;
    const expires = Number(match[1]);
    if (expires <= now() || expires > now() + ttl * 1000) return false;
    try { const signature = decode(match[3]); if (encode(signature) !== match[3]) return false; return await crypto.subtle.verify('HMAC', await key(), signature, encoder.encode(token.slice(0, token.lastIndexOf('.')))); }
    catch { return false; }
  }
  async function matchesAccessKey(value) {
    if (typeof value !== 'string' || value.length > 4096) return false;
    expectedHash ??= crypto.subtle.digest('SHA-256', encoder.encode(accessKey));
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
    const expected = new Uint8Array(await expectedHash);
    let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    return difference === 0;
  }
  return async function fetchApi(request) {
    try {
      const url = new URL(request.url);
      const site = request.headers.get('sec-fetch-site');
      const requestOrigin = request.headers.get('origin');
      // Exact origin also rejects localhost DNS rebinding and untrusted proxy Host values.
      if (url.origin !== expectedOrigin || (requestOrigin !== null && requestOrigin !== expectedOrigin) || (site && !['same-origin', 'none'].includes(site))) return error('ORIGIN_REJECTED', 'This origin is not allowed.', 403);
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method) && requestOrigin !== expectedOrigin) return error('ORIGIN_REJECTED', 'A same-origin Origin header is required.', 403);
      if (url.pathname === '/api/capabilities') {
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'Use GET.', 405);
        return json({ storage, workspaceSync: Boolean(store), authentication: accessKey ? 'access-key' : 'none', authenticated: Boolean(store) && await authenticated(request) });
      }
      if (!store) return error('NOT_IMPLEMENTED', 'Server persistence is disabled in this prototype.', 501);
      if (url.pathname === '/api/session') {
        if (request.method === 'DELETE') return json({ authenticated: false }, 200, { 'Set-Cookie': cookieHeader('', 0) });
        if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'Use POST or DELETE.', 405);
        const data = await bodyJson(request);
        if (!plainObject(data) || Object.keys(data).some(field => field !== 'accessKey') || !accessKey || !await matchesAccessKey(data.accessKey)) return error('UNAUTHORIZED', 'Access key was not accepted.', 401);
        const payload = 'v1.' + (now() + ttl * 1000) + '.' + crypto.randomUUID();
        const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(), encoder.encode(payload))));
        return json({ authenticated: true }, 200, { 'Set-Cookie': cookieHeader(payload + '.' + signature) });
      }
      if (!['/api/workspace/snapshot', '/api/workspace/export'].includes(url.pathname)) return error('NOT_IMPLEMENTED', 'This workspace endpoint is not implemented.', 501);
      if (!await authenticated(request)) return error('UNAUTHORIZED', 'Sign in to access the server snapshot.', 401);
      if (url.pathname === '/api/workspace/export') {
        if (request.method !== 'GET') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405, { Allow: 'GET' });
        const options = url.searchParams;
        if ([...options.keys()].some(key => !['format', 'includeTrash'].includes(key)) || options.getAll('format').length > 1 || options.getAll('includeTrash').length > 1) return error('EXPORT_OPTIONS', 'Use one format and one includeTrash option.', 400);
        const format = options.get('format') ?? 'native-json';
        const includeTrash = options.get('includeTrash') ?? 'false';
        if (!['native-json', 'markdown-csv-zip'].includes(format) || !['true', 'false'].includes(includeTrash)) return error('EXPORT_OPTIONS', 'Unsupported export options.', 400);
        const saved = await store.read();
        if (saved.snapshot === null) return error('SNAPSHOT_NOT_FOUND', 'No workspace has been saved on this server.', 404);
        const exported = await buildWorkspaceExport(saved.snapshot, { format, includeTrash: includeTrash === 'true', now: new Date(now()).toISOString() });
        return new Response(exported.bytes, { headers: {
          'Content-Type': exported.mimeType,
          'Content-Disposition': `attachment; filename="yumunio-workspace-${new Date(now()).toISOString().slice(0, 10)}.${format === 'native-json' ? 'json' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(exported.filename).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}`,
          'Content-Length': String(exported.bytes.byteLength),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Yumunio-Revision': String(saved.revision)
        } });
      }
      if (request.method === 'GET') return json(await store.read());
      if (request.method !== 'PUT') return error('METHOD_NOT_ALLOWED', 'Use GET or PUT.', 405);
      const data = await bodyJson(request);
      if (!plainObject(data) || Object.keys(data).some(field => !['expectedRevision', 'snapshot'].includes(field)) || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0 || data.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new SnapshotError('INVALID_REVISION', 'Expected a nonnegative safe revision.');
      const snapshot = validateSnapshot(data.snapshot);
      return json(await store.write(data.expectedRevision, snapshot));
    } catch (cause) {
      if (cause instanceof SnapshotError) return error(cause.code, cause.message, cause.status, cause.details);
      return error('STORAGE_ERROR', 'Unable to access server persistence.', 500);
    }
  };
}

const encoder = new TextEncoder();
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export class BlobStoreError extends Error {
  constructor(code = 'BLOB_UNAVAILABLE') { super('Attachment storage is unavailable.'); this.name = 'BlobStoreError'; this.code = code; }
}
const fail = code => { throw new BlobStoreError(code); };
const hex = value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
const hmac = async (key, text) => crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw',
  typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(text));
export function blobKey(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(value) ||
      value.split('/').some(part => !part || part.length > 128)) fail('INVALID_BLOB_KEY');
  return value;
}
function string(env, key, { required = true, max = 4096 } = {}) {
  const value = env[key] ?? '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (required && !value)) fail('BLOB_CONFIGURATION');
  return value;
}
export function readBlobConfig(env = {}, { runtime = 'node' } = {}) {
  const driver = env.YUMUNIO_BLOB_DRIVER || 'disabled';
  if (driver === 'disabled') return Object.freeze({ driver });
  if (!['local', 's3', 'r2'].includes(driver)) fail('BLOB_CONFIGURATION');
  if (driver === 'local') {
    if (runtime !== 'node') fail('BLOB_CONFIGURATION');
    return Object.freeze({ driver, directory: string(env, 'YUMUNIO_BLOB_LOCAL_DIR', { required: false }) || '.data/blobs' });
  }
  if (driver === 'r2') {
    if (runtime !== 'worker') fail('BLOB_CONFIGURATION');
    const binding = string(env, 'YUMUNIO_R2_BINDING', { required: false, max: 80 }) || 'BLOBS';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding)) fail('BLOB_CONFIGURATION');
    return Object.freeze({ driver, binding });
  }
  const endpoint = string(env, 'YUMUNIO_S3_ENDPOINT', { max: 2048 });
  let url; try { url = new URL(endpoint); } catch { fail('BLOB_CONFIGURATION'); }
  if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password || url.search || url.hash) fail('BLOB_CONFIGURATION');
  const region = string(env, 'YUMUNIO_S3_REGION', { max: 80 }), bucket = string(env, 'YUMUNIO_S3_BUCKET', { max: 63 });
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(region) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) fail('BLOB_CONFIGURATION');
  const prefix = string(env, 'YUMUNIO_S3_PREFIX', { max: 256 });
  if (!prefix.endsWith('/')) fail('BLOB_CONFIGURATION');
  blobKey(prefix.slice(0, -1));
  const style = env.YUMUNIO_S3_FORCE_PATH_STYLE ?? 'true';
  if (!['true', 'false'].includes(style)) fail('BLOB_CONFIGURATION');
  if (style === 'false' && (url.port || bucket.includes('.'))) fail('BLOB_CONFIGURATION');
  return Object.freeze({ driver, endpoint, region, bucket, prefix, pathStyle: style === 'true',
    accessKeyId: string(env, 'YUMUNIO_S3_ACCESS_KEY_ID', { max: 256 }),
    secretAccessKey: string(env, 'YUMUNIO_S3_SECRET_ACCESS_KEY'),
    sessionToken: string(env, 'YUMUNIO_S3_SESSION_TOKEN', { required: false }) });
}
export async function storageProfile(config) {
  const fields = config.driver === 's3' ? [config.driver, config.endpoint, config.region, config.bucket, config.prefix, config.pathStyle] :
    config.driver === 'local' ? [config.driver, config.directory] : [config.driver, config.binding];
  return 'blob-' + (await sha256(encoder.encode(JSON.stringify(fields)))).slice(0, 32);
}

/** Header-based SigV4, with one fully hashed payload and no query credentials. */
export async function signS3Request({ url, method, region, accessKeyId, secretAccessKey, sessionToken = '', body = new Uint8Array(), headers = {}, now = new Date() }) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || !['GET', 'PUT', 'HEAD', 'DELETE'].includes(method)) fail('BLOB_CONFIGURATION');
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), date = timestamp.slice(0, 8);
  const values = new Headers(headers);
  values.set('host', target.host); values.set('x-amz-date', timestamp); values.set('x-amz-content-sha256', await sha256(body));
  if (sessionToken) values.set('x-amz-security-token', sessionToken);
  const names = [...values.keys()].sort();
  const canonicalHeaders = names.map(name => name + ':' + values.get(name).trim().replace(/\s+/g, ' ') + '\n').join('');
  const canonical = [method, target.pathname, '', canonicalHeaders, names.join(';'), values.get('x-amz-content-sha256')].join('\n');
  const scope = date + '/' + region + '/s3/aws4_request';
  const toSign = ['AWS4-HMAC-SHA256', timestamp, scope, await sha256(encoder.encode(canonical))].join('\n');
  const key = await hmac(await hmac(await hmac(await hmac('AWS4' + secretAccessKey, date), region), 's3'), 'aws4_request');
  values.set('authorization', 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ',SignedHeaders=' + names.join(';') + ',Signature=' + hex(await hmac(key, toSign)));
  return values;
}
export async function boundedBlobBytes(stream, max = MAX_BLOB_BYTES) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch {} fail('BLOB_TOO_LARGE'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}
function input(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BLOB_BYTES) fail('BLOB_TOO_LARGE');
  return bytes.slice();
}
export async function createS3BlobStore(config, { fetcher = globalThis.fetch.bind(globalThis), now = () => new Date() } = {}) {
  if (config.driver !== 's3' || typeof fetcher !== 'function') fail('BLOB_CONFIGURATION');
  const profileId = await storageProfile(config);
  async function request(method, key, bytes = new Uint8Array()) {
    blobKey(key);
    const endpoint = new URL(config.endpoint);
    if (!config.pathStyle) endpoint.hostname = config.bucket + '.' + endpoint.hostname;
    endpoint.pathname = '/' + (config.pathStyle ? encode(config.bucket) + '/' : '') + (config.prefix + key).split('/').map(encode).join('/');
    const headers = await signS3Request({ url: endpoint.href, method, region: config.region,
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken,
      body: bytes, now: now(), headers: method === 'PUT' ? { 'content-type': 'application/octet-stream', 'if-none-match': '*' } : {} });
    let response;
    try { response = await fetcher(endpoint.href, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(30000), ...(method === 'PUT' ? { body: bytes } : {}) }); }
    catch { fail('BLOB_UNAVAILABLE'); }
    if (response.status === 404) { try { await response.body?.cancel(); } catch {} return null; }
    if (response.status === 412) { try { await response.body?.cancel(); } catch {} fail('BLOB_EXISTS'); }
    if (!response.ok) { try { await response.body?.cancel(); } catch {} fail('BLOB_UNAVAILABLE'); }
    return response;
  }
  return Object.freeze({ profileId,
    async put(key, value) {
      const bytes = input(value), response = await request('PUT', key, bytes);
      if (!response) fail('BLOB_UNAVAILABLE');
      try { await response.body?.cancel(); } catch {}
      return { size: bytes.length, checksum: await sha256(bytes) };
    },
    async get(key) {
      const response = await request('GET', key); if (!response) return null;
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BLOB_BYTES)) { try { await response.body?.cancel(); } catch {} fail('BLOB_TOO_LARGE'); }
      return boundedBlobBytes(response.body);
    },
    async delete(key) { const response = await request('DELETE', key); try { await response?.body?.cancel(); } catch {} }
  });
}
export async function createR2BlobStore(binding, config = { driver: 'r2', binding: 'BLOBS' }) {
  if (!binding || !['put', 'get', 'delete'].every(method => typeof binding[method] === 'function')) fail('BLOB_CONFIGURATION');
  const profileId = await storageProfile(config);
  return Object.freeze({ profileId,
    async put(key, value) {
      blobKey(key); const bytes = input(value); const checksum = await sha256(bytes);
      let result;
      try { result = await binding.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: checksum,
        httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' } }); }
      catch { fail('BLOB_UNAVAILABLE'); }
      if (!result) fail('BLOB_EXISTS');
      return { size: bytes.length, checksum };
    },
    async get(key) {
      blobKey(key); let object;
      try { object = await binding.get(key); } catch { fail('BLOB_UNAVAILABLE'); }
      if (!object) return null;
      if (!Number.isSafeInteger(object.size) || object.size > MAX_BLOB_BYTES || !object.body) fail('BLOB_UNAVAILABLE');
      const bytes = await boundedBlobBytes(object.body);
      if (bytes.length !== object.size) fail('BLOB_UNAVAILABLE');
      return bytes;
    },
    async delete(key) { blobKey(key); try { await binding.delete(key); } catch { fail('BLOB_UNAVAILABLE'); } }
  });
}

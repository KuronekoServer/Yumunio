import { readOAuthConfig } from './oauth.js';
import { validatePublicOrigin } from '../../prototype/src/config.js';

const invalid = field => { throw new Error('Invalid identity configuration: ' + field + '.'); };
const boolean = (value, fallback, field) => {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalid(field);
};
export function normalizeDomain(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s/@:#?\\]/u.test(value) || value.endsWith('.')) return invalid('email domain');
  let host;
  try { host = new URL('https://' + value).hostname; } catch { return invalid('email domain'); }
  if (host.length > 253 || !host.includes('.') || !host.split('.').every(part => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return invalid('email domain');
  return host;
}
export function createDomainPolicy({ mode = 'unrestricted', allowedDomains = [], blockedDomains = [], allowSubdomains = false, blockSubdomains = true } = {}) {
  if (!['unrestricted', 'allowlist'].includes(mode) || !Array.isArray(allowedDomains) || !Array.isArray(blockedDomains) ||
      typeof allowSubdomains !== 'boolean' || typeof blockSubdomains !== 'boolean' || allowedDomains.length > 100 || blockedDomains.length > 100) return invalid('domain policy');
  const allowed = [...new Set(allowedDomains.map(normalizeDomain))];
  const blocked = [...new Set(blockedDomains.map(normalizeDomain))];
  if (mode === 'allowlist' && !allowed.length) return invalid('empty allowlist');
  return Object.freeze({ mode, allowedDomains: Object.freeze(allowed), blockedDomains: Object.freeze(blocked), allowSubdomains, blockSubdomains });
}
/** Registration policy; changing this does not revoke existing users' sessions. */
export function isEmailAllowed(email, policy) {
  if (typeof email !== 'string' || email.length > 254 || email !== email.trim() || /[\s\u0000-\u001f]/u.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || email.indexOf('@') !== at) return false;
  let domain;
  try { domain = normalizeDomain(email.slice(at + 1)); } catch { return false; }
  const matches = (candidate, subdomains) => domain === candidate || (subdomains && domain.endsWith('.' + candidate));
  if (policy.blockedDomains.some(item => matches(item, policy.blockSubdomains))) return false;
  return policy.mode === 'unrestricted' || policy.allowedDomains.some(item => matches(item, policy.allowSubdomains));
}
export function readIdentityConfig(env = {}) {
  const enabled = boolean(env.YUMUNIO_ACCOUNTS_ENABLED, false, 'YUMUNIO_ACCOUNTS_ENABLED');
  if (!enabled) return { enabled: false };
  const origin = validatePublicOrigin(env.YUMUNIO_PUBLIC_ORIGIN || '');
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return invalid('HTTPS public origin');
  const secret = env.YUMUNIO_AUTH_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096) return invalid('YUMUNIO_AUTH_SECRET');
  const registrationMode = env.YUMUNIO_REGISTRATION_MODE || 'closed';
  if (!['open', 'closed'].includes(registrationMode)) return invalid('YUMUNIO_REGISTRATION_MODE (open or closed)');
  const list = key => env[key] ? env[key].split(',').map(part => part.trim()) : [];
  const domainPolicy = createDomainPolicy({
    mode: env.YUMUNIO_EMAIL_DOMAIN_MODE || 'unrestricted',
    allowedDomains: list('YUMUNIO_EMAIL_ALLOWED_DOMAINS'), blockedDomains: list('YUMUNIO_EMAIL_BLOCKED_DOMAINS'),
    allowSubdomains: boolean(env.YUMUNIO_EMAIL_ALLOW_SUBDOMAINS, false, 'YUMUNIO_EMAIL_ALLOW_SUBDOMAINS'),
    blockSubdomains: boolean(env.YUMUNIO_EMAIL_BLOCK_SUBDOMAINS, true, 'YUMUNIO_EMAIL_BLOCK_SUBDOMAINS')
  });
  return { enabled: true, origin, secret, registrationMode, domainPolicy, oauth: readOAuthConfig(env) };
}

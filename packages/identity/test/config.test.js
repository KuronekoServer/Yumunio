import test from 'node:test';
import assert from 'node:assert/strict';
import { createDomainPolicy, isEmailAllowed, readIdentityConfig } from '../src/config.js';
test('identity is opt-in and enabled configuration requires an exact HTTPS or loopback origin and its own secret', () => {
  assert.deepEqual(readIdentityConfig({ YUMUNIO_AUTH_SECRET: 'not read while disabled' }), { enabled: false });
  const env = { YUMUNIO_ACCOUNTS_ENABLED: 'true', YUMUNIO_PUBLIC_ORIGIN: 'https://workspace.example', YUMUNIO_AUTH_SECRET: 'fixture-'.repeat(8) };
  assert.equal(readIdentityConfig(env).registrationMode, 'closed');
  for (const patch of [{ YUMUNIO_AUTH_SECRET: 'short' }, { YUMUNIO_PUBLIC_ORIGIN: 'http://workspace.example' }, { YUMUNIO_PUBLIC_ORIGIN: 'https://workspace.example/' }, { YUMUNIO_REGISTRATION_MODE: 'unknown' }, { YUMUNIO_EMAIL_DOMAIN_MODE: 'allowlist' }]) assert.throws(() => readIdentityConfig({ ...env, ...patch }));
});
test('email domain policy uses exact DNS boundaries, explicit subdomain rules, IDN normalization and block precedence', () => {
  const policy = createDomainPolicy({ mode: 'allowlist', allowedDomains: ['studio.example', '例え.jp'], blockedDomains: ['private.studio.example'], allowSubdomains: true });
  assert.equal(isEmailAllowed('user@studio.example', policy), true);
  assert.equal(isEmailAllowed('user@team.studio.example', policy), true);
  assert.equal(isEmailAllowed('user@evil-studio.example', policy), false);
  assert.equal(isEmailAllowed('user@studio.example.evil.invalid', policy), false);
  assert.equal(isEmailAllowed('user@private.studio.example', policy), false);
  assert.equal(isEmailAllowed('user@sub.private.studio.example', policy), false);
  assert.equal(isEmailAllowed('user@例え.jp', policy), true);
  assert.equal(isEmailAllowed('user@xn--r8jz45g.jp', policy), true);
  for (const value of ['user@studio.example.', 'user@studio.example:443', 'user@studio.example/a', 'user@@studio.example', ' user@studio.example', 'user\r\n@studio.example']) assert.equal(isEmailAllowed(value, policy), false);
  assert.equal(isEmailAllowed('user@team.studio.example', createDomainPolicy({ mode: 'allowlist', allowedDomains: ['studio.example'] })), false);
});

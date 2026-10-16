import test from 'node:test';
import assert from 'node:assert/strict';
import { MailError, readMailConfig, validateMailConfig, validateMailMessage, createHttpMailer } from '../src/mail.js';

const smtpEnv = { YUMUNIO_MAIL_DRIVER: 'smtp', YUMUNIO_SMTP_HOST: 'smtp.example.invalid', YUMUNIO_SMTP_FROM: 'no-reply@example.invalid', YUMUNIO_SMTP_USER: 'fixture-user', YUMUNIO_SMTP_PASSWORD: 'fixture-secret' };
const relay = { driver: 'http', endpoint: 'https://relay.example.invalid/send', bearerToken: 'fixture-token', from: 'no-reply@example.invalid', replyTo: 'support@example.invalid' };
const message = { to: 'member@example.invalid', subject: 'Account verification', text: 'Verification link fixture: https://workspace.example.invalid/verify?token=private-fixture' };
const code = expected => error => error instanceof MailError && error.code === expected;

test('disabled config reads no SMTP/HTTP secrets and creates no sender', async () => {
  const env = new Proxy({}, { get(_target, key) { if (key === 'YUMUNIO_MAIL_DRIVER') return 'disabled'; throw new Error('Secret getter must not run'); } });
  assert.deepEqual(readMailConfig(env), { driver: 'disabled' });
  assert.deepEqual(readMailConfig(), { driver: 'disabled' });
  const mailer = createHttpMailer(readMailConfig(env), { fetch() { throw new Error('No requests allowed'); } });
  await assert.rejects(mailer.send(message), code('MAIL_DISABLED'));
  await mailer.close();
});

test('SMTP config permits only mandatory TLS and coherent optional authentication', () => {
  const config = readMailConfig(smtpEnv);
  assert.equal(config.driver, 'smtp'); assert.equal(config.port, 587); assert.equal(config.tls, 'starttls_required');
  assert.equal(config.password, smtpEnv.YUMUNIO_SMTP_PASSWORD);
  assert.equal(readMailConfig({ ...smtpEnv, YUMUNIO_SMTP_TLS: 'implicit_tls' }).port, 465);
  assert.equal(readMailConfig({ ...smtpEnv, YUMUNIO_SMTP_USER: '', YUMUNIO_SMTP_PASSWORD: '' }).user, '');
  for (const extra of [
    { YUMUNIO_SMTP_TLS: 'opportunistic' }, { YUMUNIO_SMTP_TLS: 'disabled' }, { YUMUNIO_SMTP_PORT: '0' },
    { YUMUNIO_SMTP_PORT: '65536' }, { YUMUNIO_SMTP_PORT: '587.0' }, { YUMUNIO_SMTP_USER: '' },
    { YUMUNIO_SMTP_HOST: '127.0.0.1' }, { YUMUNIO_SMTP_HOST: 'smtp://smtp.example.invalid' },
  ]) assert.throws(() => readMailConfig({ ...smtpEnv, ...extra }), code('MAIL_CONFIGURATION'));
});

test('sender configuration rejects address lists and injected headers without echoing values', () => {
  const secret = 'private-fixture';
  for (const extra of [
    { YUMUNIO_SMTP_FROM: 'a@example.invalid,b@example.invalid' },
    { YUMUNIO_SMTP_FROM: 'Sender <a@example.invalid>' },
    { YUMUNIO_SMTP_FROM: 'a@example.invalid\r\nBcc: ' + secret },
    { YUMUNIO_SMTP_REPLY_TO: 'a@example.invalid\nb@example.invalid' },
  ]) assert.throws(() => readMailConfig({ ...smtpEnv, ...extra }), error => code('MAIL_CONFIGURATION')(error) && !String(error).includes(secret));
});

test('HTTP relay requires HTTPS and a separate Bearer token; HTTP loopback is test-only', () => {
  assert.equal(validateMailConfig(relay).endpoint, relay.endpoint);
  for (const endpoint of [
    'http://relay.example.invalid/send', 'https://user:password@relay.example.invalid/send',
    'https://relay.example.invalid/send?token=secret', 'https://relay.example.invalid/send#secret',
  ]) assert.throws(() => validateMailConfig({ ...relay, endpoint }), code('MAIL_CONFIGURATION'));
  assert.throws(() => validateMailConfig({ ...relay, bearerToken: 'bad\r\ntoken' }), code('MAIL_CONFIGURATION'));
  assert.throws(() => validateMailConfig({ ...relay, bearerToken: '' }), code('MAIL_CONFIGURATION'));
  const local = { ...relay, endpoint: 'http://127.0.0.1:8789/send' };
  assert.throws(() => validateMailConfig(local), code('MAIL_CONFIGURATION'));
  assert.equal(validateMailConfig(local, { allowLoopbackHttp: true }).endpoint, local.endpoint);
  assert.throws(() => validateMailConfig({ ...local, endpoint: 'http://localhost:8789/send' }, { allowLoopbackHttp: true }), code('MAIL_CONFIGURATION'));
  assert.equal(readMailConfig({ YUMUNIO_MAIL_DRIVER: 'http', YUMUNIO_SMTP_FROM: relay.from, YUMUNIO_MAIL_HTTP_ENDPOINT: relay.endpoint, YUMUNIO_MAIL_HTTP_TOKEN: relay.bearerToken }).driver, 'http');
});

test('messages allow Unicode plain text and exactly one bare mailbox', () => {
  const unicode = { ...message, to: 'member+tag@EXAMPLE.INVALID', subject: 'メールの確認', text: '確認用リンクです。🙂\nhttps://workspace.example.invalid/verify' };
  assert.deepEqual(validateMailMessage(unicode), { ...unicode, to: 'member+tag@example.invalid' });
  for (const input of [
    { ...message, to: 'a@example.invalid,b@example.invalid' }, { ...message, to: ['a@example.invalid'] },
    { ...message, to: 'User <a@example.invalid>' }, { ...message, to: 'a@example.invalid\r\nBcc:b@example.invalid' },
    { ...message, subject: 'Verify\r\nBcc:b@example.invalid' }, { ...message, subject: ' ' },
    { ...message, text: { path: '/private' } }, { ...message, text: 'x'.repeat(65537) },
    { ...message, html: '<img src="https://example.invalid">' }, { ...message, cc: 'other@example.invalid' },
  ]) assert.throws(() => validateMailMessage(input), code('MAIL_INVALID_MESSAGE'));
});

test('HTTP transport uses only the fixed JSON contract and never parses provider content', async () => {
  let calls = 0;
  const mailer = createHttpMailer(relay, { async fetch(url, options) {
    calls++; assert.equal(url, relay.endpoint);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + relay.bearerToken);
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { from: relay.from, ...message, replyTo: relay.replyTo });
    return new Response('provider-body-private-fixture', { status: 202 });
  } });
  assert.deepEqual(await mailer.send(message), { status: 'accepted' }); assert.equal(calls, 1);
  await mailer.close();
});

test('HTTP non-2xx and provider exceptions are sanitized with no automatic retry', async () => {
  for (const status of [302, 400, 401, 429, 500]) {
    let calls = 0;
    const mailer = createHttpMailer(relay, { async fetch() { calls++; return new Response('private-response', { status }); } });
    await assert.rejects(mailer.send(message), code('MAIL_SEND_FAILED')); assert.equal(calls, 1); await mailer.close();
  }
  const mailer = createHttpMailer(relay, { async fetch() { throw Object.assign(new Error('fixture-token ' + message.text), { response: 'private-response' }); } });
  await assert.rejects(mailer.send(message), error => code('MAIL_SEND_FAILED')(error) && error.cause === undefined && !JSON.stringify(error).includes('fixture-token') && !String(error).includes('private-fixture'));
  await mailer.close();
});

test('HTTP transport blocks SMTP in runtime-neutral code and rejects invalid mail before requests', async () => {
  assert.throws(() => createHttpMailer(readMailConfig(smtpEnv)), code('MAIL_UNSUPPORTED'));
  let calls = 0;
  const mailer = createHttpMailer(relay, { async fetch() { calls++; return new Response(null, { status: 204 }); } });
  await assert.rejects(mailer.send({ ...message, to: 'bad' }), code('MAIL_INVALID_MESSAGE'));
  assert.equal(calls, 0); assert.deepEqual(await mailer.send(message), { status: 'accepted' }); await mailer.close();
});

test('closing HTTP transport waits for admitted work and blocks new sends', async () => {
  let accept;
  const mailer = createHttpMailer(relay, { fetch: () => new Promise(resolve => { accept = resolve; }) });
  const sending = mailer.send(message); const closed = mailer.close(); let done = false;
  closed.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  accept(new Response(null, { status: 204 }));
  assert.deepEqual(await sending, { status: 'accepted' }); await closed;
  await assert.rejects(mailer.send(message), code('MAIL_SEND_FAILED'));
});

test('mailbox IDN domains normalize to punycode while SMTPUTF8 local-parts remain unsupported', () => {
  const unicodeDomain = '例え.テスト';
  const asciiDomain = 'xn--r8jz45g.xn--zckzah';
  assert.equal(validateMailMessage({ ...message, to: 'member+' + 'tag@' + unicodeDomain }).to, 'member+tag@' + asciiDomain);
  const config = validateMailConfig({ ...relay, from: 'sender@' + unicodeDomain, replyTo: 'support@' + unicodeDomain });
  assert.equal(config.from, 'sender@' + asciiDomain); assert.equal(config.replyTo, 'support@' + asciiDomain);
  assert.throws(() => validateMailMessage({ ...message, to: '利用者@example.invalid' }), code('MAIL_INVALID_MESSAGE'));
  for (const domain of ['example.invalid:443', 'example.invalid/path', 'example.invalid%0d%0a', 'example.invalid\\other']) assert.throws(() => validateMailMessage({ ...message, to: 'member@' + domain }), code('MAIL_INVALID_MESSAGE'));
});

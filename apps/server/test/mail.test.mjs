import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeMailer } from '../mail.mjs';
import { MailError, readMailConfig } from '@yumunio/identity/mail';

const config = readMailConfig({ YUMUNIO_MAIL_DRIVER: 'smtp', YUMUNIO_SMTP_HOST: 'smtp.example.invalid', YUMUNIO_SMTP_FROM: 'no-reply@example.invalid', YUMUNIO_SMTP_REPLY_TO: 'support@example.invalid', YUMUNIO_SMTP_USER: 'fixture-user', YUMUNIO_SMTP_PASSWORD: 'fixture-secret' });
const message = { to: 'member@example.invalid', subject: 'Verification fixture', text: 'Private verification URL fixture' };
const code = expected => error => error instanceof MailError && error.code === expected;

test('SMTP transport requires certificate validation and STARTTLS without protocol logging', async () => {
  let options; let outgoing; let closed = 0;
  const mailer = createNodeMailer(config, { createTransport(value) {
    options = value;
    return { async sendMail(value) { outgoing = value; return { accepted: [value.to], rejected: [], messageId: '<fixture-id@example.invalid>', response: 'private-provider-response' }; }, close() { closed++; }, verify() { throw new Error('Must not verify'); } };
  } });
  assert.equal(options.secure, false); assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false);
  assert.equal(options.opportunisticTLS, false); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.servername, config.host);
  assert.equal(options.tls.minVersion, 'TLSv1.2'); assert.equal(options.logger, false); assert.equal(options.debug, false); assert.equal(options.transactionLog, false);
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(options.maxRecipients, 1);
  assert.deepEqual(options.auth, { user: config.user, pass: config.password });
  assert.deepEqual(await mailer.send(message), { status: 'accepted', id: '<fixture-id@example.invalid>' });
  assert.deepEqual(outgoing, { from: config.from, ...message, replyTo: config.replyTo, envelope: { from: config.from, to: [message.to] }, disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1 });
  await mailer.close(); await mailer.close(); assert.equal(closed, 1);
});

test('implicit SMTP TLS starts encrypted and does not fall back to plaintext', async () => {
  let options;
  const mailer = createNodeMailer({ ...config, tls: 'implicit_tls', port: 465 }, { createTransport(value) { options = value; return { sendMail() { throw new Error('No send'); }, close() {} }; } });
  assert.equal(options.secure, true); assert.equal(options.requireTLS, false); assert.equal(options.ignoreTLS, false); assert.equal(options.opportunisticTLS, false);
  await mailer.close();
});

test('SMTP SDK invocation alone is not acceptance and recipient rejection fails', async () => {
  for (const info of [undefined, {}, { accepted: [] }, { accepted: ['other@example.invalid'] }, { accepted: [message.to], rejected: [message.to] }]) {
    const mailer = createNodeMailer(config, { createTransport() { return { async sendMail() { return info; } }; } });
    await assert.rejects(mailer.send(message), code('MAIL_SEND_FAILED')); await mailer.close();
  }
});

test('SMTP transport and construction failures never expose credentials, links or provider diagnostics', async () => {
  const sensitive = config.password + ' ' + message.text;
  assert.throws(() => createNodeMailer(config, { createTransport() { throw new Error(sensitive); } }), error => code('MAIL_CONFIGURATION')(error) && !String(error).includes(config.password));
  const mailer = createNodeMailer(config, { createTransport() { return { async sendMail() { throw Object.assign(new Error(sensitive), { response: sensitive }); } }; } });
  await assert.rejects(mailer.send(message), error => code('MAIL_SEND_FAILED')(error) && error.cause === undefined && !String(error).includes(config.password) && !JSON.stringify(error).includes(message.text));
  await mailer.close();
});

test('SMTP rejects header injection and file-like text before calling its SDK', async () => {
  let calls = 0;
  const mailer = createNodeMailer(config, { createTransport() { return { async sendMail() { calls++; return { accepted: [message.to] }; } }; } });
  for (const input of [{ ...message, to: message.to + ',other@example.invalid' }, { ...message, subject: 'Verify\r\nBcc: other@example.invalid' }, { ...message, text: { path: '/private' } }]) await assert.rejects(mailer.send(input), code('MAIL_INVALID_MESSAGE'));
  assert.equal(calls, 0); await mailer.close();
});

test('unsafe or overlong optional message IDs are omitted after confirmed acceptance', async () => {
  for (const messageId of ['id\r\nSecret: value', 'x'.repeat(201), { private: true }]) {
    const mailer = createNodeMailer(config, { createTransport() { return { async sendMail() { return { accepted: [message.to], messageId }; } }; } });
    assert.deepEqual(await mailer.send(message), { status: 'accepted' }); await mailer.close();
  }
});

test('Node disabled and HTTP modes never construct an SMTP transport', async () => {
  const createTransport = () => { throw new Error('SMTP must not be constructed'); };
  const disabled = createNodeMailer({ driver: 'disabled', get password() { throw new Error('Secret must not be read'); } }, { createTransport });
  await assert.rejects(disabled.send(message), code('MAIL_DISABLED')); await disabled.close();
  const http = createNodeMailer({ driver: 'http', endpoint: 'https://relay.example.invalid/send', bearerToken: 'fixture-token', from: config.from }, { createTransport, async fetch() { return new Response(null, { status: 204 }); } });
  assert.deepEqual(await http.send(message), { status: 'accepted' }); await http.close();
});

test('SMTP close waits for admitted messages and rejects later sends', async () => {
  let accept; let closed = false;
  const mailer = createNodeMailer(config, { createTransport() { return { sendMail: () => new Promise(resolve => { accept = resolve; }), close() { closed = true; } }; } });
  const sending = mailer.send(message); const closing = mailer.close(); await Promise.resolve(); assert.equal(closed, false);
  accept({ accepted: [message.to] }); await sending; await closing; assert.equal(closed, true);
  await assert.rejects(mailer.send(message), code('MAIL_SEND_FAILED'));
});

test('real Nodemailer factory can be created and closed without verify or send', async () => {
  const mailer = createNodeMailer(config);
  await mailer.close();
});

test('SMTP receives the canonical punycode recipient without expanding its recipient list', async () => {
  let outgoing;
  const mailer = createNodeMailer(config, { createTransport() { return { async sendMail(value) { outgoing = value; return { accepted: [value.to] }; } }; } });
  assert.deepEqual(await mailer.send({ ...message, to: 'member@例え.テスト' }), { status: 'accepted' });
  assert.equal(outgoing.to, 'member@xn--r8jz45g.xn--zckzah');
  assert.deepEqual(outgoing.envelope.to, ['member@xn--r8jz45g.xn--zckzah']);
  await mailer.close();
});

const errors = {
  MAIL_CONFIGURATION: 'Mail transport configuration is invalid.',
  MAIL_DISABLED: 'Mail sending is disabled.',
  MAIL_UNSUPPORTED: 'This mail transport is unavailable in this runtime.',
  MAIL_INVALID_MESSAGE: 'The mail message is invalid.',
  MAIL_SEND_FAILED: 'The mail service did not confirm acceptance.',
};

export class MailError extends Error {
  constructor(code) {
    super(errors[code] || errors.MAIL_SEND_FAILED);
    this.name = 'MailError';
    this.code = Object.hasOwn(errors, code) ? code : 'MAIL_SEND_FAILED';
  }
}
const fail = code => { throw new MailError(code); };
const controls = /[\u0000-\u001f\u007f]/;
const hostname = value => typeof value === 'string' && value.length <= 253 && value.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));

function mailbox(value, code) {
  if (typeof value !== 'string' || value.length > 254 || controls.test(value)) fail(code);
  const pieces = value.split('@');
  const local = pieces[0]; const domain = pieces[1];
  if (pieces.length !== 2 || !local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain || /[\s%/:?#\[\]\\]/.test(domain)) fail(code);
  let asciiDomain;
  try { asciiDomain = new URL('https://' + domain).hostname; } catch { fail(code); }
  const address = local + '@' + asciiDomain;
  if (!hostname(asciiDomain) || address.length > 254) fail(code);
  return address;
}

/** One bare mailbox: ASCII local-part, IDN domain normalized to punycode. SMTPUTF8 local-parts, lists, display names and MIME inputs are not accepted. */
export function validateMailMessage(message) {
  const code = 'MAIL_INVALID_MESSAGE';
  if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).some(key => !['to', 'subject', 'text'].includes(key))) fail(code);
  const to = mailbox(message.to, code);
  if (typeof message.subject !== 'string' || !message.subject.trim() || message.subject.length > 200 || controls.test(message.subject) || /[\u0085\u2028\u2029]/.test(message.subject)) fail(code);
  if (typeof message.text !== 'string' || !message.text || message.text.includes('\0') || new TextEncoder().encode(message.text).length > 65536) fail(code);
  return { to, subject: message.subject, text: message.text };
}

/** Pure configuration validation; loopback HTTP is available only through explicit test options. */
export function validateMailConfig(config, { allowLoopbackHttp = false } = {}) {
  const code = 'MAIL_CONFIGURATION';
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail(code);
  if (config.driver === 'disabled') return Object.freeze({ driver: 'disabled' });
  if (!['smtp', 'http', 'cloudflare'].includes(config.driver)) fail(code);
  const from = mailbox(config.from, code);
  const replyTo = config.replyTo === undefined || config.replyTo === '' ? undefined : mailbox(config.replyTo, code);
  const common = { driver: config.driver, from, ...(replyTo ? { replyTo } : {}) };
  if (config.driver === 'cloudflare') return Object.freeze(common);
  if (config.driver === 'smtp') {
    if (!hostname(config.host) || /^[0-9.]+$/.test(config.host) || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !['starttls_required', 'implicit_tls'].includes(config.tls)) fail(code);
    const user = config.user ?? ''; const password = config.password ?? '';
    if (typeof user !== 'string' || user.length > 1024 || user.includes('\0') || typeof password !== 'string' || password.length > 4096 || password.includes('\0') || Boolean(user) !== Boolean(password)) fail(code);
    return Object.freeze({ ...common, host: config.host.toLowerCase(), port: config.port, tls: config.tls, user, password });
  }
  if (typeof config.endpoint !== 'string' || config.endpoint.length > 2048 || controls.test(config.endpoint) || config.endpoint !== config.endpoint.trim()) fail(code);
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { fail(code); }
  const loopback = allowLoopbackHttp && endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopback) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) fail(code);
  if (typeof config.bearerToken !== 'string' || config.bearerToken.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(config.bearerToken)) fail(code);
  return Object.freeze({ ...common, endpoint: endpoint.href, bearerToken: config.bearerToken });
}

/** Disabled configuration intentionally reads no sender, credential or endpoint variables. */
export function readMailConfig(env = {}, options = {}) {
  const driver = env.YUMUNIO_MAIL_DRIVER || 'disabled';
  if (driver === 'disabled') return Object.freeze({ driver });
  if (!['smtp', 'http', 'cloudflare'].includes(driver)) fail('MAIL_CONFIGURATION');
  const common = { driver, from: env.YUMUNIO_SMTP_FROM, replyTo: env.YUMUNIO_SMTP_REPLY_TO };
  if (driver === 'cloudflare') return validateMailConfig(common, options);
  if (driver === 'http') return validateMailConfig({ ...common, endpoint: env.YUMUNIO_MAIL_HTTP_ENDPOINT, bearerToken: env.YUMUNIO_MAIL_HTTP_TOKEN }, options);
  const tls = env.YUMUNIO_SMTP_TLS || 'starttls_required';
  const rawPort = env.YUMUNIO_SMTP_PORT || (tls === 'implicit_tls' ? '465' : '587');
  if (typeof rawPort !== 'string' || !/^[0-9]+$/.test(rawPort)) fail('MAIL_CONFIGURATION');
  return validateMailConfig({ ...common, host: env.YUMUNIO_SMTP_HOST, port: Number(rawPort), tls, user: env.YUMUNIO_SMTP_USER, password: env.YUMUNIO_SMTP_PASSWORD }, options);
}

/** Native Email Service binding: provider acceptance requires a message ID. */
export function createCloudflareMailer(config, binding) {
  const captured = validateMailConfig(config);
  if (captured.driver !== 'cloudflare' || typeof binding?.send !== 'function') fail('MAIL_CONFIGURATION');
  const active = new Set(); let closing;
  return Object.freeze({
    async send(message) {
      if (closing) fail('MAIL_SEND_FAILED');
      const data = validateMailMessage(message);
      const pending = (async () => {
        try {
          const result = await binding.send({ from: captured.from, ...data, ...(captured.replyTo ? { replyTo: captured.replyTo } : {}) });
          if (typeof result?.messageId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/.test(result.messageId)) fail('MAIL_SEND_FAILED');
          return { status: 'accepted', id: result.messageId };
        } catch { fail('MAIL_SEND_FAILED'); }
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
    close() { return closing ??= Promise.allSettled([...active]).then(() => {}); },
  });
}

/** HTTP acceptance is not proof of delivery. No response body or provider error is exposed. */
export function createHttpMailer(config, { fetch: request = globalThis.fetch, allowLoopbackHttp = false } = {}) {
  const captured = validateMailConfig(config, { allowLoopbackHttp });
  if (captured.driver === 'disabled') return Object.freeze({ async send() { fail('MAIL_DISABLED'); }, async close() {} });
  if (captured.driver !== 'http') fail('MAIL_UNSUPPORTED');
  if (typeof request !== 'function') fail('MAIL_CONFIGURATION');
  const active = new Set(); let closing;
  return Object.freeze({
    async send(message) {
      if (closing) fail('MAIL_SEND_FAILED');
      const data = validateMailMessage(message);
      const pending = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await request(captured.endpoint, {
            method: 'POST', redirect: 'manual', credentials: 'omit', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + captured.bearerToken },
            body: JSON.stringify({ from: captured.from, ...data, ...(captured.replyTo ? { replyTo: captured.replyTo } : {}) }),
          });
          const accepted = Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
          try { response?.body?.cancel().catch(() => {}); } catch {}
          if (!accepted) fail('MAIL_SEND_FAILED');
          return { status: 'accepted' };
        } catch {
          fail('MAIL_SEND_FAILED');
        } finally { clearTimeout(timer); }
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
    close() { return closing ??= Promise.allSettled([...active]).then(() => {}); },
  });
}

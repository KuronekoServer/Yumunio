import nodemailer from 'nodemailer';
import { MailError, createHttpMailer, validateMailConfig, validateMailMessage } from './mail.js';

/** SMTP transport for Node.js and the Workers Node.js compatibility runtime. Factory construction never verifies credentials or sends mail. */
export function createSmtpMailer(config, { createTransport = nodemailer.createTransport, ...httpOptions } = {}) {
  const captured = validateMailConfig(config, httpOptions);
  if (captured.driver !== 'smtp') return createHttpMailer(captured, httpOptions);
  let transport;
  try {
    transport = createTransport({
      host: captured.host, port: captured.port, secure: captured.tls === 'implicit_tls',
      requireTLS: captured.tls === 'starttls_required', ignoreTLS: false, opportunisticTLS: false,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: captured.host },
      ...(captured.user ? { auth: { user: captured.user, pass: captured.password } } : {}),
      pool: false, logger: false, debug: false, transactionLog: false,
      disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000, dnsTimeout: 10000,
    });
    if (!transport || typeof transport.sendMail !== 'function') throw new Error();
  } catch { throw new MailError('MAIL_CONFIGURATION'); }
  const active = new Set(); let closing;
  return Object.freeze({
    async send(message) {
      if (closing) throw new MailError('MAIL_SEND_FAILED');
      const data = validateMailMessage(message);
      const pending = (async () => {
        try {
          const info = await transport.sendMail({
            from: captured.from, ...data, ...(captured.replyTo ? { replyTo: captured.replyTo } : {}),
            envelope: { from: captured.from, to: [data.to] },
            disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
          });
          if (!Array.isArray(info?.accepted) || info.accepted.length !== 1 || typeof info.accepted[0] !== 'string' || info.accepted[0].toLowerCase() !== data.to.toLowerCase() || (info.rejected !== undefined && (!Array.isArray(info.rejected) || info.rejected.length))) throw new Error();
          const id = typeof info.messageId === 'string' && info.messageId.length <= 200 && /^<?[A-Za-z0-9][A-Za-z0-9._:@+-]*>?$/.test(info.messageId) ? info.messageId : undefined;
          return { status: 'accepted', ...(id ? { id } : {}) };
        } catch { throw new MailError('MAIL_SEND_FAILED'); }
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
    close() {
      return closing ??= (async () => {
        await Promise.allSettled([...active]);
        try { await transport.close?.(); } catch { throw new MailError('MAIL_SEND_FAILED'); }
      })();
    },
  });
}

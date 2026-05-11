// SMTP email sender — default-configured for Gmail (smtp.gmail.com:465 SSL)
// but works with any SMTP provider via env overrides.
//
// Gmail setup:
//   1. Enable 2FA on the sending Google account
//   2. Create an App Password at https://myaccount.google.com/apppasswords
//   3. Set EMAIL_USER + EMAIL_APP_PASSWORD in .env (16-char password, no spaces)
//   4. EMAIL_TO is where the message lands (can equal EMAIL_USER)
//
// Lazy-loads nodemailer so the rest of the CLI doesn't pay its import cost
// unless email is actually being sent.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('email');

export type EmailAttachment = {
  /** Absolute path on disk. */
  path: string;
  /** Override displayed filename. Defaults to basename(path). */
  filename?: string;
  /** Override Content-Type. Auto-inferred by nodemailer when omitted. */
  contentType?: string;
};

export type EmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  subjectPrefix: string;
};

export type SendEmailOptions = {
  subject: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body (optional). */
  html?: string;
  attachments?: EmailAttachment[];
  /** Override recipient. Defaults to EMAIL_TO. */
  to?: string;
  /** Override config (test injection). */
  config?: Partial<EmailConfig>;
};

export type SendEmailResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
  attachmentCount: number;
};

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

function loadEnvConfig(): EmailConfig {
  const host = process.env.EMAIL_HOST?.trim() || 'smtp.gmail.com';
  const portRaw = process.env.EMAIL_PORT?.trim() || '465';
  const port = parseInt(portRaw, 10);
  if (!Number.isFinite(port)) {
    throw new EmailConfigError(`email: EMAIL_PORT is not a number: ${portRaw}`);
  }
  // 465 = implicit TLS, 587 = STARTTLS upgrade. nodemailer "secure" must be
  // true for port 465 only.
  const secureRaw = process.env.EMAIL_SECURE?.trim();
  const secure = secureRaw === undefined || secureRaw === '' ? port === 465 : secureRaw === 'true' || secureRaw === '1';

  const user = process.env.EMAIL_USER?.trim() ?? '';
  const pass = process.env.EMAIL_APP_PASSWORD?.trim() ?? process.env.EMAIL_PASSWORD?.trim() ?? '';
  const from = process.env.EMAIL_FROM?.trim() || user;
  const to = process.env.EMAIL_TO?.trim() || user;
  const subjectPrefix = process.env.EMAIL_SUBJECT_PREFIX?.trim() ?? '[career-ops]';

  if (!user) throw new EmailConfigError('email: EMAIL_USER not set in .env');
  if (!pass) throw new EmailConfigError('email: EMAIL_APP_PASSWORD not set in .env (Gmail app password — see https://myaccount.google.com/apppasswords)');
  if (!from) throw new EmailConfigError('email: EMAIL_FROM unresolved');
  if (!to) throw new EmailConfigError('email: EMAIL_TO not set in .env (the recipient address)');

  return { host, port, secure, user, pass, from, to, subjectPrefix };
}

export function isEmailConfigured(): boolean {
  try {
    loadEnvConfig();
    return true;
  } catch {
    return false;
  }
}

type Transport = {
  sendMail: (opts: Record<string, unknown>) => Promise<{
    messageId: string;
    accepted?: string[];
    rejected?: string[];
  }>;
};

let cachedTransport: Transport | null = null;
let cachedKey = '';

async function getTransport(cfg: EmailConfig): Promise<Transport> {
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}`;
  if (cachedTransport && cachedKey === key) return cachedTransport;
  // Dynamic import keeps nodemailer out of the default startup path.
  const mod = await import('nodemailer');
  const nodemailer = (mod.default ?? mod) as typeof import('nodemailer');
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  }) as unknown as Transport;
  cachedKey = key;
  return cachedTransport;
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const cfg = { ...loadEnvConfig(), ...(opts.config ?? {}) } as EmailConfig;
  const to = opts.to ?? cfg.to;

  const attachments = (opts.attachments ?? []).map((a) => {
    if (!fs.existsSync(a.path)) {
      throw new Error(`email: attachment not found: ${a.path}`);
    }
    return {
      filename: a.filename ?? path.basename(a.path),
      path: a.path,
      contentType: a.contentType,
    };
  });

  const subject = cfg.subjectPrefix ? `${cfg.subjectPrefix} ${opts.subject}` : opts.subject;

  log.info(
    { to, subject, attachments: attachments.length, host: cfg.host, port: cfg.port },
    'email: sending',
  );

  const transport = await getTransport(cfg);
  const info = await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text: opts.text,
    html: opts.html,
    attachments,
  });

  log.info(
    { messageId: info.messageId, accepted: info.accepted?.length ?? 0, rejected: info.rejected?.length ?? 0 },
    'email: sent',
  );

  return {
    messageId: info.messageId,
    accepted: info.accepted ?? [],
    rejected: info.rejected ?? [],
    attachmentCount: attachments.length,
  };
}

// send-files — push one or more local files into a group chat via a
// platform webhook (currently WeChat Work; pluggable via shared/notify).
//
// Two ways to specify what to send:
//   1. Explicit file paths:        sendFiles({ paths: [...] })
//   2. By jobId:                    sendFiles({ jobId: '12345' })
//      → auto-collects every PDF in output/<source>/<company-slug>-<role-slug>/
//        (source resolved from the stored job row: seek / linkedin / indeed)
//
// Designed to be the one-stop notifier. To add more formats in the
// future, just pass them via `paths` — the underlying provider already
// dispatches by extension (.pdf/.docx/etc. → file, .png/.jpg → image).
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../shared/db/store.js';
import { applicationDir } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import { sendFiles as dispatchSend, listProviders } from '../../shared/notify/index.js';
import type { SendResult } from '../../shared/notify/index.js';

const log = createLogger('send-files');

export type SendFilesOptions = {
  /** Explicit list of file paths (absolute or relative to cwd). */
  paths?: string[];
  /** When set, auto-collects all PDFs in output/<source>/<slug>/. */
  jobId?: string;
  /** Optional file extension filter when collecting by jobId. Default: ['.pdf']. */
  extensions?: string[];
  /** Provider name (default: $WEBHOOK_PROVIDER or 'wecom'). */
  provider?: string;
  /** Webhook URL (default: $WEBHOOK_URL). */
  webhookUrl?: string;
  /** Optional text/markdown message sent before the attachments. */
  text?: string;
  /** When true, send `text` as markdown (provider-supported subset). */
  markdown?: boolean;
  /** When true (default), throw if any attachment failed. Set false to keep going. */
  throwOnFailure?: boolean;
};

export type SendFilesResult = SendResult & {
  resolvedFiles: string[];
};

function defaultExtensions(): string[] {
  return ['.pdf'];
}

function collectFilesForJob(jobId: string, extensions: string[]): string[] {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`send-files: jobId ${jobId} not in DB.`);
  const dir = applicationDir(job);
  if (!fs.existsSync(dir)) {
    throw new Error(`send-files: output dir not found for ${jobId}: ${dir}. Run apply-job first.`);
  }
  const wanted = new Set(extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase())));
  const matches = fs
    .readdirSync(dir)
    .filter((name) => wanted.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(dir, name))
    .sort();
  if (!matches.length) {
    throw new Error(
      `send-files: no files matching [${[...wanted].join(', ')}] in ${dir}. Did the render step run?`,
    );
  }
  return matches;
}

function resolveWebhookUrl(opts: SendFilesOptions): string {
  const url = opts.webhookUrl ?? process.env.WEBHOOK_URL;
  if (!url || !url.trim()) {
    throw new Error('send-files: webhook URL not set. Pass --webhook <url> or set WEBHOOK_URL in .env.');
  }
  return url;
}

function resolveProvider(opts: SendFilesOptions): string {
  const name = opts.provider ?? process.env.WEBHOOK_PROVIDER ?? 'wecom';
  return name;
}

export async function sendFiles(opts: SendFilesOptions): Promise<SendFilesResult> {
  const explicit = (opts.paths ?? []).map((p) => path.resolve(p));
  const extensions = opts.extensions && opts.extensions.length ? opts.extensions : defaultExtensions();

  let files: string[] = [...explicit];
  if (opts.jobId) {
    files = files.concat(collectFilesForJob(opts.jobId, extensions));
  }
  if (!files.length) {
    throw new Error('send-files: nothing to send (pass file paths or --jobId).');
  }
  // de-dupe while preserving order
  files = Array.from(new Set(files));

  for (const f of files) {
    if (!fs.existsSync(f)) throw new Error(`send-files: file not found: ${f}`);
  }

  const webhookUrl = resolveWebhookUrl(opts);
  const provider = resolveProvider(opts);

  log.info({ count: files.length, provider, jobId: opts.jobId ?? null }, 'send-files: dispatching');
  const result = await dispatchSend({
    files,
    webhookUrl,
    provider,
    text: opts.text,
    markdown: opts.markdown,
  });

  const failed = result.attachments.filter((a) => !a.ok);
  if (failed.length) {
    log.warn({ failed: failed.map((f) => f.filename) }, 'send-files: some attachments failed');
    if (opts.throwOnFailure !== false) {
      const summary = failed.map((f) => `${f.filename}: ${f.error ?? 'unknown'}`).join('; ');
      throw new Error(`send-files: ${failed.length}/${files.length} failed — ${summary}`);
    }
  } else {
    log.info({ count: result.attachments.length }, 'send-files: all attachments delivered');
  }

  return { ...result, resolvedFiles: files };
}

// Re-export for callers that want the bare list (used by the CLI help).
export const KNOWN_PROVIDERS = listProviders();

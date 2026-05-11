// WeChat Work (企业微信) group-bot webhook adapter.
//
// Protocol reference:
//   https://developer.work.weixin.qq.com/document/path/91770  (send)
//   https://developer.work.weixin.qq.com/document/path/91774  (upload_media)
//
// Files go in two hops:
//   1. POST <upload_media>?key=KEY&type=file  (multipart/form-data, field "media")
//      → { errcode, errmsg, media_id, ... }
//   2. POST <send>?key=KEY  { msgtype: "file", file: { media_id } }
// Same shape for type=voice. Images use the inline "image" msgtype (base64 + md5).
//
// Limits per the docs: file 5KB–20MB, image ≤2MB.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import type {
  Attachment,
  AttachmentKind,
  AttachmentResult,
  NotifyProvider,
  SendOptions,
  SendResult,
} from './types.js';

const log = createLogger('notify:wecom');

const SEND_URL_PREFIX = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';
const UPLOAD_URL_PREFIX = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media';

const FILE_MIN_BYTES = 5 * 1024;
const FILE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const VOICE_EXTS = new Set(['.amr']);

function inferKind(filename: string): AttachmentKind {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VOICE_EXTS.has(ext)) return 'voice';
  return 'file';
}

function extractKey(webhookUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error(`wecom: invalid webhook URL: ${webhookUrl}`);
  }
  const key = parsed.searchParams.get('key');
  if (!key) {
    throw new Error('wecom: webhook URL is missing the `key` query parameter');
  }
  if (!parsed.hostname.endsWith('qyapi.weixin.qq.com')) {
    throw new Error(`wecom: unexpected host ${parsed.hostname} (expected qyapi.weixin.qq.com)`);
  }
  return key;
}

type WecomResponse = { errcode?: number; errmsg?: string; media_id?: string };

async function postJson(url: string, body: unknown): Promise<WecomResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: WecomResponse;
  try {
    parsed = JSON.parse(text) as WecomResponse;
  } catch {
    throw new Error(`wecom: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (parsed.errcode && parsed.errcode !== 0) {
    throw new Error(`wecom: errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? 'unknown'}`);
  }
  return parsed;
}

async function uploadMedia(key: string, filePath: string, filename: string, kind: 'file' | 'voice'): Promise<string> {
  const buf = fs.readFileSync(filePath);
  if (buf.byteLength < FILE_MIN_BYTES) {
    throw new Error(`wecom: ${filename} is ${buf.byteLength}B (minimum 5KB)`);
  }
  if (buf.byteLength > FILE_MAX_BYTES) {
    throw new Error(`wecom: ${filename} is ${buf.byteLength}B (maximum 20MB)`);
  }

  // Use Node 20's built-in FormData / Blob — no dependency needed.
  const form = new FormData();
  // Construct a Blob with bytes only (avoid passing a Uint8Array view directly,
  // which some runtimes reject); octet-stream is fine for WeChat Work.
  const blob = new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' });
  form.append('media', blob, filename);

  const url = `${UPLOAD_URL_PREFIX}?key=${encodeURIComponent(key)}&type=${kind}`;
  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  let parsed: WecomResponse;
  try {
    parsed = JSON.parse(text) as WecomResponse;
  } catch {
    throw new Error(`wecom upload: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (parsed.errcode && parsed.errcode !== 0) {
    throw new Error(`wecom upload: errcode=${parsed.errcode} errmsg=${parsed.errmsg ?? 'unknown'}`);
  }
  if (!parsed.media_id) {
    throw new Error(`wecom upload: response missing media_id: ${text.slice(0, 200)}`);
  }
  return parsed.media_id;
}

async function sendFileByMediaId(sendUrl: string, mediaId: string, kind: 'file' | 'voice'): Promise<void> {
  await postJson(sendUrl, { msgtype: kind, [kind]: { media_id: mediaId } });
}

async function sendImage(sendUrl: string, filePath: string, filename: string): Promise<void> {
  const buf = fs.readFileSync(filePath);
  if (buf.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(`wecom: ${filename} is ${buf.byteLength}B (image max 2MB)`);
  }
  const base64 = buf.toString('base64');
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  await postJson(sendUrl, { msgtype: 'image', image: { base64, md5 } });
}

async function sendText(sendUrl: string, text: string, asMarkdown: boolean): Promise<void> {
  const payload = asMarkdown
    ? { msgtype: 'markdown', markdown: { content: text } }
    : { msgtype: 'text', text: { content: text } };
  await postJson(sendUrl, payload);
}

export const wecomProvider: NotifyProvider = {
  name: 'wecom',

  validateWebhook(url: string): void {
    extractKey(url); // throws with a clear message on failure
  },

  async send(attachments: Attachment[], opts: SendOptions): Promise<SendResult> {
    const key = extractKey(opts.webhookUrl);
    const sendUrl = `${SEND_URL_PREFIX}?key=${encodeURIComponent(key)}`;

    let textSent = false;
    if (opts.text && opts.text.trim()) {
      try {
        await sendText(sendUrl, opts.text, !!opts.markdown);
        textSent = true;
        log.info({ chars: opts.text.length, markdown: !!opts.markdown }, 'wecom: text sent');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'wecom: text send failed — continuing with attachments');
      }
    }

    const results: AttachmentResult[] = [];
    for (const a of attachments) {
      const filename = a.filename ?? path.basename(a.path);
      const kind = a.kind ?? inferKind(filename);
      try {
        if (!fs.existsSync(a.path)) throw new Error(`file not found: ${a.path}`);
        if (kind === 'image') {
          await sendImage(sendUrl, a.path, filename);
          results.push({ path: a.path, filename, ok: true });
        } else if (kind === 'file' || kind === 'voice') {
          const mediaId = await uploadMedia(key, a.path, filename, kind);
          await sendFileByMediaId(sendUrl, mediaId, kind);
          results.push({ path: a.path, filename, ok: true, handle: mediaId });
        } else {
          throw new Error(`wecom: unsupported kind "${kind}"`);
        }
        log.info({ filename, kind }, 'wecom: attachment sent');
      } catch (err) {
        const message = (err as Error).message;
        log.error({ filename, err: message }, 'wecom: attachment failed');
        results.push({ path: a.path, filename, ok: false, error: message });
      }
    }

    return { provider: 'wecom', textSent, attachments: results };
  },
};

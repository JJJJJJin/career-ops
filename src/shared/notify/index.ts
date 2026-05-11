// Notify dispatcher — picks a NotifyProvider by name and sends.
//
// Add a new chat platform by:
//   1. Implementing NotifyProvider in ./<platform>.ts
//   2. Registering it in PROVIDERS below
//   3. (Optional) Setting WEBHOOK_PROVIDER in .env, or pass --provider on the CLI
import type { Attachment, NotifyProvider, SendOptions, SendResult } from './types.js';
import { wecomProvider } from './wecom.js';

export type { Attachment, AttachmentKind, AttachmentResult, NotifyProvider, SendOptions, SendResult } from './types.js';

const PROVIDERS: Record<string, NotifyProvider> = {
  wecom: wecomProvider,
};

export type ProviderName = keyof typeof PROVIDERS;

export function listProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export function getProvider(name: string): NotifyProvider {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error(`notify: unknown provider "${name}". Available: ${listProviders().join(', ')}`);
  }
  return p;
}

export type SendFilesArgs = {
  files: Array<string | Attachment>;
  webhookUrl: string;
  provider?: string;
  text?: string;
  markdown?: boolean;
};

export async function sendFiles(args: SendFilesArgs): Promise<SendResult> {
  const provider = getProvider(args.provider ?? 'wecom');
  provider.validateWebhook(args.webhookUrl);
  const attachments: Attachment[] = args.files.map((f) => (typeof f === 'string' ? { path: f } : f));
  const opts: SendOptions = {
    webhookUrl: args.webhookUrl,
    text: args.text,
    markdown: args.markdown,
  };
  return provider.send(attachments, opts);
}

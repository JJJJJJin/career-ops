// Provider-agnostic notification interfaces. Add a new chat platform by
// implementing NotifyProvider and registering it in ./index.ts.

export type AttachmentKind = 'file' | 'image' | 'voice' | 'video';

export type Attachment = {
  /** Absolute path on local disk. */
  path: string;
  /** Override the filename shown in chat. Defaults to basename(path). */
  filename?: string;
  /** Override how the provider should send it. Auto-inferred from extension if absent. */
  kind?: AttachmentKind;
};

export type SendOptions = {
  /** Provider-specific endpoint (e.g. a WeChat Work webhook URL). */
  webhookUrl: string;
  /** Optional text/markdown message sent before the attachments. */
  text?: string;
  /** When true, treat `text` as markdown (provider-supported subset). */
  markdown?: boolean;
};

export type AttachmentResult = {
  path: string;
  filename: string;
  ok: boolean;
  /** Provider-specific handle (e.g. WeChat Work media_id) when successful. */
  handle?: string;
  error?: string;
};

export type SendResult = {
  provider: string;
  textSent: boolean;
  attachments: AttachmentResult[];
};

export interface NotifyProvider {
  readonly name: string;
  /** Cheap sanity check on the webhook URL — throw with a clear message if malformed. */
  validateWebhook(url: string): void;
  send(attachments: Attachment[], opts: SendOptions): Promise<SendResult>;
}

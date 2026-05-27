// MCP tool-result helpers. Every tool returns a `content` array (what the agent
// reads) and, for structured data, a mirrored `structuredContent` object. We do
// NOT declare outputSchema on tools (avoids per-call validation friction), so
// structuredContent is advisory — the text block is the source of truth.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Success: human-readable text + the structured payload. */
export function ok(data: Record<string, unknown>, text?: string): ToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Failure: surfaced to the agent as an error result so it can react/stop-and-ask. */
export function fail(message: string, data: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    structuredContent: { error: message, ...data },
    isError: true,
  };
}

/**
 * A step needs a value only a human can supply (an emailed code, a captcha
 * answer, an employer answer not in the guideline). NOT an error: the browser
 * stays open server-side; the agent asks the user and calls back. This is the
 * MCP-native replacement for the file-polling human-input broker.
 */
export function needsHumanInput(
  prompt: string,
  kind: 'text' | 'password' | 'code' = 'text',
  data: Record<string, unknown> = {},
): ToolResult {
  return {
    content: [{ type: 'text', text: `NEEDS HUMAN INPUT (${kind}): ${prompt}` }],
    structuredContent: { status: 'needs_human_input', prompt, kind, ...data },
  };
}

/** Run a tool body, turning any thrown error into a `fail` result. */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** A result carrying a JPEG screenshot (base64) plus an explanatory line. */
export function withScreenshot(jpegBase64: string, text: string, data: Record<string, unknown> = {}): ToolResult {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: jpegBase64, mimeType: 'image/jpeg' },
    ],
    structuredContent: data,
  };
}

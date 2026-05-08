// Anthropic SDK wrapper with strict-JSON helper, retries, and structured logging.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm');

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!config.llm.anthropicApiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.',
      );
    }
    _client = new Anthropic({ apiKey: config.llm.anthropicApiKey });
  }
  return _client;
}

export type CallJsonOptions = {
  step: string;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  retries?: number;
};

/**
 * Extract a JSON object from an Anthropic response. The system prompt and
 * `prefill: '{'` strongly nudge the model into strict JSON mode, but it
 * occasionally wraps in ```json fences anyway — strip them first.
 */
function extractJson<T>(text: string): T {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  // We pre-filled '{', so the assistant's reply may start mid-object. Add it back.
  if (!s.startsWith('{') && !s.startsWith('[')) {
    s = '{' + s;
  }
  try {
    return JSON.parse(s) as T;
  } catch (err) {
    // Sometimes the model emits trailing prose. Try to find the last balanced object.
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1)) as T;
    }
    throw new Error(
      `LLM did not return valid JSON: ${(err as Error).message}\n--- raw ---\n${text.slice(0, 500)}`,
    );
  }
}

export async function callJson<T>(opts: CallJsonOptions): Promise<T> {
  const model = opts.model ?? config.llm.model;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.2;
  const retries = opts.retries ?? 2;

  const system = `${opts.systemPrompt}

CRITICAL: Reply with a single JSON object only. No prose before or after, no markdown fences. The reply must start with { and end with }.`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      log.debug({ step: opts.step, attempt, model }, 'llm: request');
      const response = await client().messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system,
        messages: [
          { role: 'user', content: opts.userPrompt },
          // Prefill '{' so the model continues with valid JSON.
          { role: 'assistant', content: '{' },
        ],
      });

      const block = response.content[0];
      const raw = block && block.type === 'text' ? block.text : '';
      const out = extractJson<T>(raw);

      log.info(
        {
          step: opts.step,
          model,
          attempt,
          ms: Date.now() - t0,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          stopReason: response.stop_reason,
        },
        'llm: ok',
      );
      return out;
    } catch (err) {
      lastErr = err;
      log.warn(
        { step: opts.step, attempt, err: (err as Error).message, ms: Date.now() - t0 },
        'llm: failed (will retry if attempts remain)',
      );
      if (attempt < retries) {
        const backoffMs = 500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('LLM call failed');
}

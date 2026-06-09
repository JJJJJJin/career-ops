// LLM client — multi-provider routing + primary/fallback chain.
//
// Most providers in `providers.ts` speak the OpenAI chat-completions API
// (native or compatible) and share one OpenAI SDK. Anthropic is the exception:
// it is driven through the official @anthropic-ai/sdk Messages API (kind:
// 'anthropic'), with prompt caching on the stable prefix. Configuration:
//
//   LLM_PROVIDER          primary provider name      (default: openai)
//   LLM_MODEL             primary model id           (default: provider's first model)
//   LLM_FALLBACK_PROVIDER fallback provider name     (default: deepseek)
//   LLM_FALLBACK_MODEL    fallback model id          (default: provider's first model)
//
// API keys are read from each provider's apiKeyEnv (OPENAI_API_KEY,
// DEEPSEEK_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY).
//
// Fallback fires when the primary throws and at least one retry has been
// burned, OR when the primary's API key is missing.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { getProvider, type ProviderName } from './providers.js';

const log = createLogger('llm');

type ResolvedTarget = {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseURL?: string;
};

type ClientCacheEntry = { client: OpenAI; baseURL?: string };
const clientCache = new Map<string, ClientCacheEntry>();
const anthropicCache = new Map<string, Anthropic>();

function makeClient(target: ResolvedTarget): OpenAI {
  const cacheKey = `${target.provider}:${target.apiKey.slice(0, 8)}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached.client;
  const client = new OpenAI({
    apiKey: target.apiKey,
    ...(target.baseURL ? { baseURL: target.baseURL } : {}),
  });
  clientCache.set(cacheKey, { client, baseURL: target.baseURL });
  return client;
}

function makeAnthropicClient(target: ResolvedTarget): Anthropic {
  const cacheKey = `${target.provider}:${target.apiKey.slice(0, 8)}`;
  const cached = anthropicCache.get(cacheKey);
  if (cached) return cached;
  const client = new Anthropic({ apiKey: target.apiKey });
  anthropicCache.set(cacheKey, client);
  return client;
}

function resolveTarget(provider: ProviderName, modelOverride?: string): ResolvedTarget | null {
  const cfg = getProvider(provider);
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) return null;
  const model = modelOverride ?? cfg.models[0];
  if (!model) throw new Error(`Provider ${provider} has no model configured`);
  return { provider, model, apiKey, baseURL: cfg.baseURL };
}

function extractJson<T>(text: string): T {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(s) as T;
  } catch (err) {
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

export type CallJsonOptions = {
  step: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Large, stable content shared across calls (e.g. the candidate profile when
   * generating resumes for many jobs). Rendered BEFORE userPrompt so it forms a
   * cacheable prefix. On Anthropic it gets a `cache_control` breakpoint (real
   * prompt-cache hits across a batch); on OpenAI it's simply prepended (OpenAI
   * auto-caches identical prefixes too). Keep it byte-identical across calls.
   */
  cachePrefix?: string;
  /** Override primary model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-target retry count BEFORE falling back. Default 1. */
  retries?: number;
};

async function callOnce<T>(target: ResolvedTarget, opts: CallJsonOptions): Promise<T> {
  const kind = getProvider(target.provider).kind ?? 'openai';
  return kind === 'anthropic' ? callAnthropicOnce<T>(target, opts) : callOpenAiOnce<T>(target, opts);
}

async function callOpenAiOnce<T>(target: ResolvedTarget, opts: CallJsonOptions): Promise<T> {
  const client = makeClient(target);
  const t0 = Date.now();
  log.debug({ step: opts.step, provider: target.provider, model: target.model }, 'llm: request');

  // OpenAI auto-caches identical prefixes, so a stable cachePrefix can simply
  // lead the user content.
  const userContent = opts.cachePrefix
    ? `${opts.cachePrefix}\n\n${opts.userPrompt}`
    : opts.userPrompt;

  // gpt-5.x+ models require the word 'json' to appear in messages when
  // using response_format: { type: 'json_object' }. Append to system prompt.
  const systemWithJson = opts.systemPrompt.includes('json')
    ? opts.systemPrompt
    : `${opts.systemPrompt}\n\nRespond with a JSON object.`;

  const resp = await client.chat.completions.create({
    model: target.model,
    response_format: { type: 'json_object' },
    temperature: opts.temperature ?? 0.2,
    // Use max_completion_tokens (newer API). max_tokens is deprecated on gpt-5.x+ models.
    max_completion_tokens: opts.maxTokens ?? 4096,
    messages: [
      { role: 'system', content: systemWithJson },
      { role: 'user', content: userContent },
    ],
  });

  const content = resp.choices[0]?.message?.content ?? '';
  log.info(
    {
      step: opts.step,
      provider: target.provider,
      model: target.model,
      ms: Date.now() - t0,
      promptTokens: resp.usage?.prompt_tokens,
      completionTokens: resp.usage?.completion_tokens,
      totalTokens: resp.usage?.total_tokens,
      finishReason: resp.choices[0]?.finish_reason,
    },
    'llm: ok',
  );
  if (!content) throw new Error(`LLM (${opts.step}) returned empty response`);
  return extractJson<T>(content);
}

// Anthropic native path (Messages API). Differs from the OpenAI path in three
// ways: (1) JSON is requested via the system prompt and parsed tolerantly —
// Anthropic has no `response_format: json_object`; (2) sampling params
// (temperature/top_p) are NOT sent — Opus 4.8 rejects them with a 400; (3) the
// system prompt + cachePrefix carry `cache_control` breakpoints so repeated
// calls in a batch read from the prompt cache instead of re-billing the prefix.
const JSON_SUFFIX =
  '\n\nReturn ONLY a single valid JSON object. No prose, no explanation, no markdown code fences.';

async function callAnthropicOnce<T>(target: ResolvedTarget, opts: CallJsonOptions): Promise<T> {
  const client = makeAnthropicClient(target);
  const t0 = Date.now();
  log.debug({ step: opts.step, provider: target.provider, model: target.model }, 'llm: request');

  const userBlocks: Anthropic.TextBlockParam[] = [];
  if (opts.cachePrefix) {
    userBlocks.push({
      type: 'text',
      text: opts.cachePrefix,
      cache_control: { type: 'ephemeral' },
    });
  }
  userBlocks.push({ type: 'text', text: opts.userPrompt });

  const resp = await client.messages.create({
    model: target.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: [
      {
        type: 'text',
        text: opts.systemPrompt + JSON_SUFFIX,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userBlocks }],
  });

  const content = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  log.info(
    {
      step: opts.step,
      provider: target.provider,
      model: target.model,
      ms: Date.now() - t0,
      promptTokens: resp.usage.input_tokens,
      completionTokens: resp.usage.output_tokens,
      cacheReadTokens: resp.usage.cache_read_input_tokens,
      cacheWriteTokens: resp.usage.cache_creation_input_tokens,
      stopReason: resp.stop_reason,
    },
    'llm: ok',
  );
  if (resp.stop_reason === 'max_tokens') {
    log.warn(
      { step: opts.step, model: target.model, maxTokens: opts.maxTokens ?? 4096 },
      'llm: hit max_tokens — JSON may be truncated; consider raising maxTokens',
    );
  }
  if (!content) throw new Error(`LLM (${opts.step}) returned empty response`);
  return extractJson<T>(content);
}

async function callWithRetry<T>(target: ResolvedTarget, opts: CallJsonOptions): Promise<T> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callOnce<T>(target, opts);
    } catch (err) {
      lastErr = err;
      log.warn(
        {
          step: opts.step,
          provider: target.provider,
          model: target.model,
          attempt,
          err: (err as Error).message,
        },
        'llm: attempt failed',
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('LLM call failed');
}

export async function callJson<T>(opts: CallJsonOptions): Promise<T> {
  const primary = resolveTarget(config.llm.provider, opts.model ?? config.llm.model);
  const fallback = config.llm.fallbackProvider
    ? resolveTarget(config.llm.fallbackProvider, config.llm.fallbackModel ?? undefined)
    : null;

  // No primary key → go straight to fallback if available.
  if (!primary) {
    if (!fallback) {
      throw new Error(
        `No API key for primary provider (${config.llm.provider}, env: ${getProvider(config.llm.provider).apiKeyEnv}) and no fallback configured.`,
      );
    }
    log.warn(
      { primary: config.llm.provider, fallback: fallback.provider },
      'llm: primary key missing, using fallback',
    );
    return callWithRetry<T>(fallback, opts);
  }

  try {
    return await callWithRetry<T>(primary, opts);
  } catch (err) {
    if (!fallback) throw err;
    log.warn(
      {
        step: opts.step,
        primary: primary.provider,
        primaryModel: primary.model,
        fallback: fallback.provider,
        fallbackModel: fallback.model,
        err: (err as Error).message,
      },
      'llm: primary exhausted, switching to fallback',
    );
    return callWithRetry<T>(fallback, opts);
  }
}

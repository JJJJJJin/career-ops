// LLM provider registry. Most providers are reachable via the OpenAI SDK —
// some are native OpenAI, others speak OpenAI-compatible endpoints
// (DeepSeek, Gemini, Groq). Anthropic is the exception: it is driven through
// the official @anthropic-ai/sdk (the Messages API), NOT an OpenAI-compatible
// shim — the `kind` field tells the client which code path to take.
// Add a provider by appending one entry here.

export type ProviderName = 'openai' | 'deepseek' | 'gemini' | 'groq' | 'anthropic';

/** Which SDK / wire protocol the client uses to reach the provider. */
export type ProviderKind = 'openai' | 'anthropic';

export type ProviderConfig = {
  name: ProviderName;
  /** SDK/protocol family. Defaults to 'openai' when omitted. */
  kind?: ProviderKind;
  /** OpenAI-SDK baseURL. Omit for native OpenAI default. (openai kind only.) */
  baseURL?: string;
  /** Env variable holding the API key. */
  apiKeyEnv: string;
  /** Known-good models (top of list = canonical default). */
  models: string[];
  /** Whether the provider supports `response_format: { type: 'json_object' }`. Anthropic does not (it gets JSON via instructed-output + tolerant parse). */
  supportsJsonMode: boolean;
};

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  openai: {
    name: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    // gpt-5.4-nano: cheap default. Larger models below for higher quality on
    // resume / cover-letter generation.
    models: [
      'gpt-5.4-nano',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-4o-mini',
      'gpt-4o',
      'gpt-4-turbo',
      'o1-mini',
      'o1',
    ],
    supportsJsonMode: true,
  },
  deepseek: {
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    // deepseek-chat = V3 (general). deepseek-reasoner = R1 (reasoning,
    // slower, higher latency, often better at JSON contracts).
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsJsonMode: true,
  },
  gemini: {
    name: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-pro',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
    supportsJsonMode: true,
  },
  groq: {
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
    supportsJsonMode: true,
  },
  anthropic: {
    name: 'anthropic',
    kind: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    // claude-opus-4-8 = most capable (best for resume/cover-letter quality).
    // sonnet = faster/cheaper balance; haiku = cheapest. Override with LLM_MODEL.
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    // Anthropic doesn't use OpenAI's json_object mode; the client requests JSON
    // via the system prompt and parses tolerantly (Claude follows it reliably).
    supportsJsonMode: false,
  },
};

export function getProvider(name: ProviderName): ProviderConfig {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown LLM_PROVIDER: ${name}. Valid: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

export function defaultModelFor(name: ProviderName): string {
  const m = PROVIDERS[name].models[0];
  if (!m) throw new Error(`Provider ${name} has no models configured`);
  return m;
}

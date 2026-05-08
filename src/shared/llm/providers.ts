// LLM provider registry. Every provider is reachable via the OpenAI SDK —
// some are native OpenAI, others speak OpenAI-compatible endpoints
// (DeepSeek, Gemini, Groq). Add a provider by appending one entry here.

export type ProviderName = 'openai' | 'deepseek' | 'gemini' | 'groq';

export type ProviderConfig = {
  name: ProviderName;
  /** OpenAI-SDK baseURL. Omit for native OpenAI default. */
  baseURL?: string;
  /** Env variable holding the API key. */
  apiKeyEnv: string;
  /** Known-good models (top of list = canonical default). */
  models: string[];
  /** Whether the provider supports `response_format: { type: 'json_object' }`. All current entries do. */
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

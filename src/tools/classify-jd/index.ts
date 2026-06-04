// classify-jd — map a JD to exactly one archetype (backend | full-stack |
// ai-agent). This selects the resume summary variant and the default bullet
// ordering. LLM is allowed here (strict-JSON), with a deterministic keyword
// fallback when no API key is configured.
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary } from '../../shared/db/types.js';
import { summarizeJob } from '../summarize-job/index.js';
import { ARCHETYPES, type Archetype } from '../../shared/library/types.js';

const log = createLogger('classify-jd');

export type JdClassification = {
  archetype: Archetype;
  /** Lowercased selection tags the JD emphasizes (drives bullet ordering). */
  emphasisTags: string[];
  rationale: string;
};

const SYSTEM_PROMPT = `You classify a software job posting into exactly ONE archetype, for resume targeting. Output strict JSON. Definitions:
- "ai-agent": the role centers on LLM/agent/ML systems, RAG, prompt/agent orchestration, or AI product work.
- "backend": the role centers on server-side services, APIs, data, concurrency, distributed systems, platform/infra — no strong frontend requirement.
- "full-stack": the role genuinely requires both frontend (React/UI) and backend across the stack.
Pick the single best fit. Also list the emphasis tags (from this fixed set) the posting stresses, most important first: backend, frontend, ai-llm, automation, concurrency, real-time, ddd, devops, observability, data, embedded, scrum, leadership, communication.`;

const SCHEMA = `Return JSON: { "archetype": "backend"|"full-stack"|"ai-agent", "emphasisTags": string[], "rationale": string }`;

// Keyword → emphasis tag, for the deterministic fallback + emphasis enrichment.
const KEYWORD_TAGS: Array<[RegExp, string]> = [
  [/\b(react|vue|angular|frontend|front-end|ui|css|tailwind)\b/i, 'frontend'],
  [/\b(llm|rag|agent|prompt|openai|genai|gen ai|fine-tun|ml|machine learning|nlp)\b/i, 'ai-llm'],
  [/\b(websocket|real-?time|streaming|push|kafka|pub\/?sub)\b/i, 'real-time'],
  [/\b(concurren|race condition|locking|thread|parallel)\b/i, 'concurrency'],
  [/\b(docker|kubernetes|k8s|ci\/?cd|terraform|aws|gcp|azure|devops|pipeline)\b/i, 'devops'],
  [/\b(observability|logging|monitoring|metrics|tracing)\b/i, 'observability'],
  [/\b(sql|postgres|mysql|database|etl|data pipeline|analytics)\b/i, 'data'],
  [/\b(embedded|firmware|rtos|driver|microcontroller|spi|i2c|can bus)\b/i, 'embedded'],
  [/\b(rest|api|microservice|backend|back-end|server-side|flask|django|node|spring)\b/i, 'backend'],
  [/\b(scrum|agile|sprint)\b/i, 'scrum'],
  [/\b(automation|workflow|scraping|playwright|selenium)\b/i, 'automation'],
  [/\b(domain-driven|ddd|layered architecture|clean architecture)\b/i, 'ddd'],
];

function deriveTags(text: string): string[] {
  const seen = new Set<string>();
  for (const [re, tag] of KEYWORD_TAGS) if (re.test(text)) seen.add(tag);
  return [...seen];
}

function heuristicArchetype(tags: string[]): Archetype {
  const has = (t: string) => tags.includes(t);
  if (has('ai-llm')) return 'ai-agent';
  if (has('frontend') && has('backend')) return 'full-stack';
  return 'backend';
}

export type ClassifyOptions = { summary?: JobSummary; force?: boolean };

export async function classifyJd(jobId: string, opts: ClassifyOptions = {}): Promise<JdClassification> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`classify-jd: ${jobId} not in DB. Run seek-extract first.`);
  const summary = opts.summary ?? (await summarizeJob(jobId));

  const jdText = [
    summary.oneLineSummary,
    ...summary.responsibilities,
    ...summary.mustHaveRequirements,
    ...summary.niceToHaveRequirements,
    ...summary.techStack,
    summary.domain,
    job.description,
  ].join('\n');
  const heuristicTags = deriveTags(jdText);

  // Fallback path: no LLM key → pure heuristic.
  const hasKey = Boolean(process.env[`${(config.llm.provider || '').toUpperCase()}_API_KEY`]) ||
    Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.DEEPSEEK_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasKey) {
    const archetype = heuristicArchetype(heuristicTags);
    log.info({ jobId, archetype, mode: 'heuristic' }, 'classify-jd: no API key, heuristic classification');
    return { archetype, emphasisTags: heuristicTags, rationale: 'Heuristic (no LLM key): keyword-based.' };
  }

  try {
    const out = await callJson<Partial<JdClassification>>({
      step: 'classify-jd',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `${SCHEMA}

JOB TITLE: ${job.title}
DOMAIN: ${summary.domain}
SENIORITY: ${summary.seniority}

JOB SUMMARY:
${JSON.stringify(summary, null, 2)}`,
    });
    const archetype: Archetype = ARCHETYPES.includes(out.archetype as Archetype)
      ? (out.archetype as Archetype)
      : heuristicArchetype(heuristicTags);
    // Merge LLM emphasis with heuristic tags (LLM order first).
    const llmTags = (out.emphasisTags ?? []).map((t) => t.toLowerCase());
    const emphasisTags = [...new Set([...llmTags, ...heuristicTags])];
    log.info({ jobId, archetype, tags: emphasisTags.length, mode: 'llm' }, 'classify-jd: complete');
    return { archetype, emphasisTags, rationale: out.rationale ?? '' };
  } catch (err) {
    const archetype = heuristicArchetype(heuristicTags);
    log.warn({ jobId, err: (err as Error).message }, 'classify-jd: LLM failed, using heuristic');
    return { archetype, emphasisTags: heuristicTags, rationale: 'Heuristic fallback (LLM error).' };
  }
}

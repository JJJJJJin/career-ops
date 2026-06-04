// Claim grounding — the prose equivalent of the résumé's validateTraceability.
//
// LLM-written prose (cover letter, outreach, company-brief self-claims) cannot
// be checked byte-for-byte like selected résumé bullets, so we enforce grounding
// in TWO layers:
//
//   Layer A (deterministic, the hard guardrail): on the RAW text, every number/
//     metric, technology name, seniority/title word, and date must be present in
//     the grounding. These are the categories most likely to be fabricated AND
//     mechanically checkable. Pure code — no model trust.
//
//   Layer B (adversarial verifier, soft prose only): paraphrased "I did X"
//     professional claims are atomized and each is checked by a STRICT verifier
//     that defaults to unsupported unless it can point to a specific grounding
//     bullet. Complements — never replaces — Layer A.
//
// Judgment is intentionally strict: over-flag for human review rather than emit
// an unsupported claim. Used by cover-letter, outreach, and company-brief.
import { callJson } from '../llm/client.js';
import { createLogger } from '../logger.js';
import type { ContentLibrary } from '../library/types.js';
import { baseNormalize } from '../library/synonyms.js';

const log = createLogger('grounding');

export type ClaimViolation = {
  layer: 'hard' | 'soft';
  category: 'metric' | 'tech' | 'title' | 'date' | 'experience';
  value: string;
  reason: string;
};

export type ValidationResult = { ok: boolean; violations: ClaimViolation[] };

export type Grounding = {
  /** Text the prose was grounded on (selected bullets + summary + company/title/date). Numbers must come from here. */
  supportText: string;
  /** The selected bullets, given to the soft verifier as the evidence set. */
  bullets: string[];
  /** Technologies the candidate legitimately has (whole library). */
  allowedTech: Set<string>;
  /** Library role/project titles + the target job title (normalized). */
  allowedTitles: string[];
  /** Allowed date tokens: library periods + today. */
  allowedDates: Set<string>;
};

// Curated lexicon of common engineering technologies. A term from here that
// appears in the prose but is NOT in the candidate's library → fabrication.
const TECH_LEXICON = [
  // NOTE: bare 'go' and 'r' are omitted — too common as English words to scan
  // safely; 'golang' covers the realistic fabrication of Go.
  'python', 'java', 'javascript', 'typescript', 'c++', 'c#', 'golang', 'rust', 'ruby', 'php', 'scala',
  'kotlin', 'swift', 'objective-c', 'elixir', 'matlab',
  'react', 'angular', 'vue', 'svelte', 'next.js', 'nuxt', 'flask', 'django', 'fastapi', 'spring', 'spring boot',
  'express', 'nestjs', 'rails', 'laravel', '.net', 'asp.net', 'node.js', 'jakarta',
  'postgresql', 'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'cassandra', 'dynamodb', 'oracle', 'sql server',
  'elasticsearch', 'kafka', 'rabbitmq', 'celery', 'spark', 'hadoop', 'airflow', 'snowflake', 'databricks',
  'docker', 'kubernetes', 'k8s', 'terraform', 'ansible', 'aws', 'gcp', 'azure', 'lambda', 'ec2', 's3',
  'jenkins', 'github actions', 'gitlab ci', 'circleci', 'prometheus', 'grafana', 'datadog',
  'graphql', 'grpc', 'rest', 'websocket', 'playwright', 'selenium', 'cypress', 'jest', 'pytest',
  'tensorflow', 'pytorch', 'keras', 'scikit-learn', 'pandas', 'numpy', 'hugging face', 'langchain', 'llama',
  'openai', 'anthropic', 'tesseract', 'opencv', 'spi', 'i2c', 'can bus', 'freertos', 'wiringpi',
];

const SENIORITY_TOKENS = ['senior', 'lead', 'principal', 'staff', 'head of', 'manager', 'architect', 'director', 'expert', 'specialist'];

function normTech(s: string): string {
  return baseNormalize(s);
}

/** Build the grounding sets from the library + this job's selected bullets. */
export function buildGrounding(
  library: ContentLibrary,
  selectedBullets: string[],
  opts: { jobTitle?: string | null; summary?: string; today?: string },
): Grounding {
  const supportPieces = [...selectedBullets];
  if (opts.summary) supportPieces.push(opts.summary);
  if (opts.jobTitle) supportPieces.push(opts.jobTitle);
  if (opts.today) supportPieces.push(opts.today);
  const supportText = baseNormalize(supportPieces.join(' \n '));

  // Allowed tech = every tech token the library actually contains.
  const libBlob = baseNormalize([
    ...library.skills.flatMap((g) => g.items),
    ...library.projects.flatMap((p) => p.tech),
    ...library.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...library.projects.flatMap((p) => p.bullets.map((b) => b.text)),
  ].join(' \n '));
  const allowedTech = new Set<string>();
  for (const t of TECH_LEXICON) {
    if (new RegExp(`\\b${escRe(normTech(t))}\\b`).test(libBlob)) allowedTech.add(normTech(t));
  }

  const allowedTitles = library.experience.map((e) => baseNormalize(e.title));
  if (opts.jobTitle) allowedTitles.push(baseNormalize(opts.jobTitle));

  const allowedDates = new Set<string>();
  for (const e of [...library.experience, ...library.projects]) {
    for (const tok of dateTokens(e.dates ?? '')) allowedDates.add(tok);
  }
  for (const ed of library.education) for (const tok of dateTokens(ed.dates ?? '')) allowedDates.add(tok);
  if (opts.today) for (const tok of dateTokens(opts.today)) allowedDates.add(tok);

  return { supportText, bullets: selectedBullets, allowedTech, allowedTitles, allowedDates };
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract date-ish tokens: 4-digit years and month names. */
function dateTokens(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  for (const m of lower.matchAll(/\b(19|20)\d{2}\b/g)) out.push(m[0]);
  for (const m of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) out.push(m[1]);
  return out;
}

// ── Layer A: deterministic hard checks on the raw prose ──────────────────────
export function checkHardConstraints(text: string, g: Grounding): ClaimViolation[] {
  const v: ClaimViolation[] = [];
  const lower = baseNormalize(text);

  // 1. Metrics/numbers: every number must appear in the support text.
  for (const m of lower.matchAll(/\b\d[\d,]*(?:\.\d+)?\s*%?\+?/g)) {
    const raw = m[0].trim();
    const num = raw.replace(/[,\s]/g, '');
    if (!num || /^\d{4}$/.test(num) && g.allowedDates.has(num)) continue; // a year handled below
    const compact = num.replace(/[%+]/g, '');
    const support = g.supportText.replace(/[,\s]/g, '');
    if (!support.includes(compact)) {
      v.push({ layer: 'hard', category: 'metric', value: raw, reason: 'number not present in the selected bullets / summary' });
    }
  }

  // 2. Technologies: a lexicon tech in the prose that the library lacks → fabricated.
  for (const t of TECH_LEXICON) {
    const nt = normTech(t);
    if (g.allowedTech.has(nt)) continue;
    if (new RegExp(`\\b${escRe(nt)}\\b`).test(lower)) {
      v.push({ layer: 'hard', category: 'tech', value: t, reason: 'technology not present anywhere in the content library' });
    }
  }

  // 3. Seniority/title: a seniority word not covered by any allowed title.
  for (const s of SENIORITY_TOKENS) {
    if (!new RegExp(`\\b${escRe(s)}\\b`).test(lower)) continue;
    const coveredByTitle = g.allowedTitles.some((t) => t.includes(s));
    if (!coveredByTitle) {
      v.push({ layer: 'hard', category: 'title', value: s, reason: 'seniority/title word not supported by any library title or the target role' });
    }
  }

  // 4. Dates: any year/month token must be allowed.
  for (const tok of dateTokens(lower)) {
    if (!g.allowedDates.has(tok)) {
      v.push({ layer: 'hard', category: 'date', value: tok, reason: 'date not present in library periods or today' });
    }
  }

  // Dedup.
  return [...new Map(v.map((x) => [`${x.category}:${x.value}`, x])).values()];
}

// ── Layer B: adversarial verifier for soft "I did X" professional claims ─────
const VERIFY_SYSTEM = `You are a STRICT fact-checker preventing résumé/cover-letter fabrication. You are given prose written about a candidate and the ONLY evidence allowed (a list of vetted bullet points). List every professional claim the prose makes ABOUT THE CANDIDATE (things they did, built, led, or are skilled at). For each, decide if a SPECIFIC evidence bullet directly substantiates it.

Be adversarial and conservative: if you cannot point to a specific bullet that clearly supports the claim, mark it UNSUPPORTED. Paraphrase is fine; invented scope, skills, seniority, or achievements are not. Ignore generic enthusiasm, the company's attributes, and statements about the role itself — only judge factual claims about the candidate. Output strict JSON.`;

export async function verifySoftClaims(text: string, bullets: string[]): Promise<ClaimViolation[]> {
  if (!bullets.length) return [];
  const out = await callJson<{ claims?: Array<{ claim: string; supported: boolean; evidence?: string }> }>({
    step: 'verify-claims',
    systemPrompt: VERIFY_SYSTEM,
    userPrompt: `Return JSON: { "claims": [ { "claim": string, "supported": boolean, "evidence": string } ] }

EVIDENCE BULLETS (the only allowed facts):
${bullets.map((b, i) => `[${i + 1}] ${b}`).join('\n')}

PROSE TO CHECK:
${text}`,
  });
  const claims = out.claims ?? [];
  return claims
    .filter((c) => c && c.supported === false && c.claim)
    .map((c) => ({ layer: 'soft' as const, category: 'experience' as const, value: c.claim, reason: 'no specific evidence bullet supports this claim' }));
}

/** Full validation: Layer A (always) + Layer B (when bullets exist). */
export async function validateProse(text: string, g: Grounding): Promise<ValidationResult> {
  const hard = checkHardConstraints(text, g);
  let soft: ClaimViolation[] = [];
  try {
    soft = await verifySoftClaims(text, g.bullets);
  } catch (err) {
    // Don't let a verifier outage pass prose silently — flag for review.
    log.warn({ err: (err as Error).message }, 'grounding: soft verifier failed — flagging for manual review');
    soft = [{ layer: 'soft', category: 'experience', value: '(soft verifier unavailable)', reason: 'could not run adversarial claim check — review manually' }];
  }
  const violations = [...hard, ...soft];
  return { ok: violations.length === 0, violations };
}

export function formatViolations(violations: ClaimViolation[]): string {
  return violations.map((v) => `  ✗ [${v.layer}/${v.category}] "${v.value}" — ${v.reason}`).join('\n');
}

/**
 * Company-brief support check: every numeric/quant claim (funding, headcount,
 * founding year, %, $) in `text` must appear in `sourceText` (the distilled
 * company page when grounded, else the JD). Returns the unsourced numbers.
 * Qualitative company claims are not mechanically checkable — those rely on the
 * prompt + the brief's "things to verify" section.
 */
export function unsourcedNumbers(text: string, sourceText: string): string[] {
  const src = baseNormalize(sourceText).replace(/[,\s]/g, '');
  const out: string[] = [];
  for (const m of baseNormalize(text).matchAll(/\b\d[\d,]*(?:\.\d+)?\s*%?\+?/g)) {
    const compact = m[0].replace(/[,\s%+]/g, '');
    if (compact && !src.includes(compact)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/** True if prose speaks in the candidate's first-person voice (shouldn't, in a company brief). */
export function hasCandidateVoice(text: string): boolean {
  return /\b(i|i'm|i've|my|myself|the candidate)\b/i.test(text);
}

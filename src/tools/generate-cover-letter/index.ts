// generate-cover-letter — produce a TailoredCoverLetter for one job, grounded
// ONLY in this job's assembled résumé (selected bullets + chosen summary variant
// + company/title). The prose is then put through the SAME enforced grounding as
// the résumé's traceability check (shared/grounding/claims): hard deterministic
// checks on numbers/tech/seniority/dates + an adversarial verifier for soft
// "I did X" claims. On a violation we regenerate once; if it still fails, the
// draft goes to a review queue and NO clean letter / PDF is produced. We never
// silently emit a cover letter with an unsupported claim.
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import type { Job, JobSummary } from '../../shared/db/types.js';
import { ensureLibrary } from '../../shared/library/parse.js';
import { buildGrounding, validateProse, formatViolations, type ClaimViolation } from '../../shared/grounding/claims.js';
import { summarizeJob } from '../summarize-job/index.js';
import { assembleResume } from '../assemble-resume/index.js';
import type { TailoredResume } from '../assemble-resume/types.js';
import type { TailoredCoverLetter } from './types.js';

const log = createLogger('generate-cover-letter');

const MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `You write courteous, professional cover letters (about 250-320 words, 4 body paragraphs) in the voice of a genuine job applicant. Tone: polite, warm, and confident — respectful of the reader, never blunt, demanding, or presumptuous. You sell the candidate's strengths by describing real projects they delivered and the QUANTIFIED advantage those projects gave a company, team, or organisation. You are given a FIXED set of approved facts about the candidate (their selected résumé bullets + summary). You may ONLY state things supported by those facts. Every claim must trace to a specific bullet.

VOICE (this is critical):
- Write as an applicant courteously introducing themselves, NOT as a recruiter telling the employer what they need. NEVER address the reader with "You need someone who…" or "You're looking for…" or any line that tells the company what its problem is — it reads as presumptuous.
- Persuade through evidence, not adjectives: name a concrete project, then the measurable result it produced for the organisation (hours saved, accuracy, throughput, scope). Let the numbers carry the confidence.
- Be genuinely polite: a warm opening, and a closing that thanks the reader. Confidence comes from specifics, not from bluntness.
- Vary sentence length naturally; read like a thoughtful person wrote it, not a bullet list.

PARAGRAPH 1 — courteous opening: state the role being applied for and briefly, warmly introduce who the candidate is (e.g. degree/background from the approved facts) and why this work genuinely fits them. Be inviting, not boastful, and avoid empty enthusiasm.

PARAGRAPH 2 — the closest-fit project: take ONE specific theme from the job description and connect it to the candidate's most relevant project, describing what they built and the quantified outcome or scope. This is the strongest evidence of fit.

PARAGRAPH 3 — a second proof point of measurable impact: cite another project or experience from the approved facts where the candidate's work gave a team/company/organisation a quantified advantage (e.g. person-hours saved, accuracy, volume handled). Connect it to why it matters for THIS role.

PARAGRAPH 4 — gracious close: one sentence tying a genuine strength (e.g. communication, clarity, collaboration) to the role, then a polite invitation to talk and a sincere thank-you for considering the application.

HARD RULES (violations are rejected by an automated checker):
- Do NOT state any number, metric, technology, job title, seniority level, or date that is not in the approved facts.
- Do NOT inflate the internship to a senior/lead role. Use only the titles given.
- Do NOT invent achievements, scope, employers, or skills. Paraphrase the approved facts; never add to them.
- Do NOT claim a skill or technology the candidate lacks just because the JD asks for it; sell only real, supported strengths.
- No clichés ("passionate self-starter", "results-driven", "I'm thrilled", "hit the ground running"). No quoting JD requirements verbatim.
- Politeness is expressed through courtesy and specifics, never through generic enthusiasm adjectives.

Output strict JSON in the schema below.`;

const SCHEMA_HINT = `{
  "date": string,
  "recipientBlock": string,
  "salutation": string,
  "bodyParagraphs": [string, string, string, string],
  "closing": string
}`;

function renderMarkdown(c: TailoredCoverLetter): string {
  const contact = [c.contact.email, c.contact.phone, c.contact.location, c.contact.linkedinDisplay, c.contact.portfolioDisplay].filter(Boolean);
  const lines: string[] = [];
  lines.push(`# ${c.name}`);
  if (contact.length) lines.push(contact.join(' · '));
  lines.push('', c.date, '', c.recipientBlock, '', c.salutation, '');
  for (const p of c.bodyParagraphs) lines.push(p, '');
  lines.push(c.closing, c.name);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function todayPretty(): string {
  return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Keep only the sign-off line ("Best regards,") from the model's closing.
 * The model often appends the candidate name or a "[Your Name]" placeholder,
 * but renderMarkdown already adds the real name — without this we'd duplicate it.
 */
function sanitizeClosing(raw: string | undefined): string {
  const firstLine = (raw ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return firstLine && firstLine.length > 0 ? firstLine : 'Best regards,';
}

/** Load this job's assembled résumé — the grounding source. Assemble if missing. */
async function loadAssembledResume(jobId: string, slug: string, outputDir: string, force?: boolean): Promise<TailoredResume> {
  const resumeJsonPath = path.join(outputDir, `${slug}-resume.json`);
  if (force || !fs.existsSync(resumeJsonPath)) {
    await assembleResume(jobId, { force });
  }
  return JSON.parse(fs.readFileSync(resumeJsonPath, 'utf-8')) as TailoredResume;
}

export type GenerateCoverLetterResult = {
  jobId: string;
  outputDir: string;
  jsonPath: string;
  mdPath: string;
  letter: TailoredCoverLetter;
  markdown: string;
  /** True when the draft failed grounding twice and was routed to review. */
  needsReview?: boolean;
  violations?: ClaimViolation[];
  reviewPath?: string;
};

export type GenerateCoverLetterOptions = { force?: boolean };

export async function generateCoverLetter(jobId: string, opts: GenerateCoverLetterOptions = {}): Promise<GenerateCoverLetterResult> {
  const job: Job | null = db.getJob(jobId);
  if (!job) throw new Error(`generate-cover-letter: ${jobId} not in DB. Run seek-extract first.`);

  const slug = artefactBase(job);
  const outputDir = applicationDir(job);
  const jsonPath = path.join(outputDir, `${slug}-cover-letter.json`);
  const mdPath = path.join(outputDir, `${slug}-cover-letter.md`);
  const reviewPath = path.join(outputDir, `${slug}-cover-letter.NEEDS_REVIEW.md`);

  if (!opts.force && fs.existsSync(jsonPath) && fs.existsSync(mdPath)) {
    const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TailoredCoverLetter;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    log.info({ jobId, outputDir }, 'generate-cover-letter: cached output exists');
    return { jobId, outputDir, jsonPath, mdPath, letter: cached, markdown };
  }

  // Grounding: ONLY this job's selected bullets + chosen summary variant.
  const summary: JobSummary = await summarizeJob(jobId);
  const resume = await loadAssembledResume(jobId, slug, outputDir, opts.force);
  const selectedBullets = [
    ...resume.experience.flatMap((e) => e.highlights),
    ...resume.projects.flatMap((p) => p.highlights),
  ];
  const today = todayPretty();
  const grounding = buildGrounding(ensureLibrary().library, selectedBullets, {
    jobTitle: job.title,
    summary: resume.summary,
    today,
  });

  const approvedFacts = `APPROVED FACTS — the ONLY things you may claim about the candidate:
SUMMARY: ${resume.summary}
SELECTED BULLETS:
${selectedBullets.map((b) => `- ${b}`).join('\n')}`;

  const baseUserPrompt = `${SCHEMA_HINT}

JOB: ${job.title} @ ${job.company ?? 'Unknown'}
TODAY (use as date): ${today}
ROLE CONTEXT (for paragraph 1 only — about the job, not the candidate):
${summary.oneLineSummary}
${(summary.responsibilities ?? []).slice(0, 4).map((r) => `- ${r}`).join('\n')}

${approvedFacts}`;

  let lastLetter: TailoredCoverLetter | null = null;
  let lastViolations: ClaimViolation[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const avoidBlock = lastViolations.length
      ? `\n\nYOUR PREVIOUS DRAFT WAS REJECTED. Do NOT make these unsupported claims again:\n${lastViolations.map((v) => `- ${v.value} (${v.reason})`).join('\n')}`
      : '';

    log.info({ jobId, attempt, model: config.llm.model }, 'generate-cover-letter: drafting');
    const tailored = await callJson<Partial<TailoredCoverLetter>>({
      step: 'generate-cover-letter',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: baseUserPrompt + avoidBlock,
    });

    const letter: TailoredCoverLetter = {
      name: resume.name,
      contact: {
        email: resume.contact.email,
        phone: resume.contact.phone,
        location: resume.contact.location,
        linkedinDisplay: resume.contact.linkedinDisplay ?? resume.contact.linkedinUrl,
        portfolioDisplay: resume.contact.portfolioDisplay ?? resume.contact.portfolioUrl,
      },
      date: tailored.date ?? today,
      recipientBlock: tailored.recipientBlock ?? `Hiring Team\n${job.company ?? ''}`.trim(),
      salutation: tailored.salutation ?? 'Dear Hiring Team,',
      bodyParagraphs: (tailored.bodyParagraphs ?? []).slice(0, 4),
      closing: sanitizeClosing(tailored.closing),
    };
    if (letter.bodyParagraphs.length === 0) throw new Error('generate-cover-letter: LLM returned no body paragraphs');

    // ── The guardrail. Validate the prose against the grounding. ──
    const result = await validateProse(letter.bodyParagraphs.join('\n\n'), grounding);
    const hardViolations = result.violations.filter((v) => v.layer === 'hard');
    const softViolations = result.violations.filter((v) => v.layer === 'soft');
    lastLetter = letter;
    lastViolations = result.violations;

    // Hard violations (made-up numbers, fake tech, wrong seniority) → retry.
    // Soft violations (\"I built X\" not precisely traceable) → accept with flag.
    if (hardViolations.length === 0) {
      const markdown = renderMarkdown(letter);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(jsonPath, JSON.stringify(letter, null, 2), 'utf-8');
      fs.writeFileSync(mdPath, markdown, 'utf-8');
      if (fs.existsSync(reviewPath)) fs.rmSync(reviewPath);
      const note = softViolations.length
        ? `cover-letter accepted (${softViolations.length} soft flag(s) — review advised)`
        : null;
      db.updateApplicationFields(jobId, { coverLetterMd: markdown, outputDir, generatedAt: new Date().toISOString(), model: config.llm.model, ...(note ? { notes: note } : {}) });
      log.info({ jobId, attempt, hardViolations: 0, softViolations: softViolations.length }, 'generate-cover-letter: complete (hard grounding passed)');
      return { jobId, outputDir, jsonPath, mdPath, letter, markdown };
    }
    log.warn({ jobId, attempt, hardViolations: hardViolations.length, softViolations: softViolations.length }, 'generate-cover-letter: hard grounding failed');
  }

  // Two attempts done. Soft-only → accept with warnings. Hard violations → review.
  const letter = lastLetter as TailoredCoverLetter;
  const hardViolations = lastViolations.filter((v: ClaimViolation) => v.layer === 'hard');
  const softViolations = lastViolations.filter((v: ClaimViolation) => v.layer === 'soft');

  if (hardViolations.length === 0) {
    // Only soft violations after retries — accept and flag.
    const markdown = renderMarkdown(letter);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(letter, null, 2), 'utf-8');
    fs.writeFileSync(mdPath, markdown, 'utf-8');
    if (fs.existsSync(reviewPath)) fs.rmSync(reviewPath);
    const note = `cover-letter accepted after ${MAX_ATTEMPTS} attempts (${softViolations.length} soft flag(s) — review advised)`;
    db.updateApplicationFields(jobId, { coverLetterMd: markdown, outputDir, generatedAt: new Date().toISOString(), model: config.llm.model, notes: note });
    log.warn({ jobId, softViolations: softViolations.length }, 'generate-cover-letter: accepted with soft flags after retries');
    return {
      jobId, outputDir, jsonPath, mdPath, letter,
      markdown, needsReview: true, violations: lastViolations, reviewPath: undefined,
    };
  }

  // Hard violations remain → review queue. Do NOT emit a clean letter or PDF.
  const reviewMd = [
    `# ⚠ COVER LETTER — NEEDS REVIEW (hard violations after ${MAX_ATTEMPTS} attempts)`,
    `Job: ${job.title} @ ${job.company ?? ''}`,
    '',
    `## Hard violations (MUST fix — fabricated numbers, tech, titles):`,
    formatViolations(hardViolations),
    '',
    softViolations.length ? `## Soft flags (review advised):\n${formatViolations(softViolations)}\n` : '',
    `## Draft (NOT validated — do not send as-is):`,
    '',
    renderMarkdown(letter),
  ].join('\n');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(reviewPath, reviewMd, 'utf-8');
  // Ensure no stale clean output lingers.
  for (const p of [jsonPath, mdPath]) if (fs.existsSync(p)) fs.rmSync(p);
  db.updateApplicationFields(jobId, { notes: `cover-letter NEEDS_REVIEW: ${lastViolations.length} unsupported claim(s)` });
  log.warn({ jobId, violations: lastViolations.length, reviewPath }, 'generate-cover-letter: routed to review (no clean output)');

  return {
    jobId, outputDir, jsonPath, mdPath, letter,
    markdown: renderMarkdown(letter),
    needsReview: true, violations: lastViolations, reviewPath,
  };
}

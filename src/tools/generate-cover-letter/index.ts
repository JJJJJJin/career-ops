// generate-cover-letter — produce a TailoredCoverLetter for one job, grounded
// ONLY in this job's assembled résumé (selected bullets + chosen summary variant
// generate-cover-letter — produce a TailoredCoverLetter for one job. The prose
// is grounded in the candidate's assembled résumé (selected bullets + summary).
// A lightweight grounding check flags unsupported claims as warnings, but never
// blocks generation — the candidate's genuine interest and tech-stack alignment
// matter more than mechanical rule enforcement.
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

const MAX_ATTEMPTS = 1;

const SYSTEM_PROMPT = `You write concise, human cover letters (about 180-220 words, 3 short body paragraphs) for an early-career software engineer. The reader is a hiring manager who scans in 15 seconds.

VOICE:
- Confident and direct. Never use "excited," "thrilled," "love," or "passionate." Let the work speak.
- Sound like a real person emailing a peer, not a student writing an essay.
- Be specific: name technologies, state numbers, describe what was built.
- Be honest: if the candidate doesn't know a tech in the JD, it's fine to acknowledge it briefly without over-apologizing.
- Every sentence should earn its place. No filler.

STRUCTURE:
PARAGRAPH 1 (2-3 sentences) — What draws the candidate to THIS company and THIS role. Mention their degree and key background in one sentence. No "I'm writing to apply for..." — the reader already knows.

PARAGRAPH 2 (3-4 sentences) — One specific project or experience that proves the candidate can do this job. Name the stack, state the result, explain why it was hard. Numbers over adjectives: "saved 12 person-hours daily" not "dramatically improved efficiency."

PARAGRAPH 3 (1-2 sentences) — One more relevant skill or tool the candidate brings. Then close politely.

CLOSING (always exactly these words):
"Thank you for your consideration. I look forward to hearing from you."

SIGN-OFF: "Best regards,"

HARD RULES:
- Maximum ~200 words for the body paragraphs combined. Short is better.
- Do NOT invent skills or technologies not listed in the approved facts.
- Do NOT inflate seniority. The candidate is early-career.
- Do NOT use these words: excited, thrilled, passionate, love, eager, incredible, amazing.
- Do NOT write "I'm writing to apply for..." or "I came across your job posting..."
- Salutation: "Dear <Company> Hiring Team," — always formal, never "Hi" or "Hello."
- Respect gaps honestly: if the JD asks for PHP and the candidate doesn't have it, a brief honest acknowledgment is fine. Don't overcompensate with "but I learn fast."
- Avoid corporate jargon: don't say "owning features across APIs, data persistence, and operational tooling." Say what you actually built.`;

const SCHEMA_HINT = `{
  "date": string,
  "recipientBlock": string,
  "salutation": string,
  "bodyParagraphs": [string, string, string],
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
  /** Warnings from grounding (informational only — never blocks generation). */
  warnings?: ClaimViolation[];
};

export type GenerateCoverLetterOptions = { force?: boolean };

export async function generateCoverLetter(jobId: string, opts: GenerateCoverLetterOptions = {}): Promise<GenerateCoverLetterResult> {
  const job: Job | null = db.getJob(jobId);
  if (!job) throw new Error(`generate-cover-letter: ${jobId} not in DB. Run seek-extract first.`);

  const slug = artefactBase(job);
  const outputDir = applicationDir(job);
  const jsonPath = path.join(outputDir, `${slug}-cover-letter.json`);
  const mdPath = path.join(outputDir, `${slug}-cover-letter.md`);

  if (!opts.force && fs.existsSync(jsonPath) && fs.existsSync(mdPath)) {
    const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TailoredCoverLetter;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    log.info({ jobId, outputDir }, 'generate-cover-letter: cached output exists');
    return { jobId, outputDir, jsonPath, mdPath, letter: cached, markdown };
  }

  // Grounding: this job's selected bullets + chosen summary variant.
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

  const approvedFacts = `APPROVED FACTS — use these to tell the candidate's story:
SUMMARY: ${resume.summary}
SELECTED BULLETS:
${selectedBullets.map((b) => `- ${b}`).join('\n')}

CANDIDATE BACKGROUND (use freely):
- ${resume.name}, ${resume.contact.email}, ${resume.contact.location}
- ${resume.contact.linkedinDisplay || resume.contact.linkedinUrl || ''}`;

  const baseUserPrompt = `${SCHEMA_HINT}

JOB: ${job.title} @ ${job.company ?? 'Unknown'}
TODAY (use as date): ${today}
ROLE CONTEXT (what this job is about):
${summary.oneLineSummary}
${(summary.responsibilities ?? []).slice(0, 5).map((r) => `- ${r}`).join('\n')}

${approvedFacts}`;

  log.info({ jobId, model: config.llm.model }, 'generate-cover-letter: drafting');
  const tailored = await callJson<Partial<TailoredCoverLetter>>({
    step: 'generate-cover-letter',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: baseUserPrompt,
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
    bodyParagraphs: (tailored.bodyParagraphs ?? []).slice(0, 3),
    closing: sanitizeClosing(tailored.closing),
  };
  if (letter.bodyParagraphs.length === 0) throw new Error('generate-cover-letter: LLM returned no body paragraphs');

  // Lightweight grounding check — flag warnings, never block.
  let warnings: ClaimViolation[] = [];
  try {
    const result = await validateProse(letter.bodyParagraphs.join('\n\n'), grounding);
    warnings = result.violations;
    if (warnings.length) {
      log.warn({ jobId, warnings: warnings.length }, 'generate-cover-letter: grounding warnings (informational only)');
    }
  } catch (err) {
    log.warn({ jobId, err: (err as Error).message }, 'generate-cover-letter: grounding check skipped (verifier unavailable)');
  }

  const markdown = renderMarkdown(letter);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(letter, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  const note = warnings.length
    ? `cover-letter generated (${warnings.length} grounding warning(s) — review optional)`
    : null;
  db.updateApplicationFields(jobId, { coverLetterMd: markdown, outputDir, generatedAt: new Date().toISOString(), model: config.llm.model, ...(note ? { notes: note } : {}) });
  log.info({ jobId, warnings: warnings.length }, 'generate-cover-letter: complete');

  return { jobId, outputDir, jsonPath, mdPath, letter, markdown, warnings: warnings.length ? warnings : undefined };
}

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

const SYSTEM_PROMPT = `# HOW TO WRITE
1. Silently identify the top 3-4 requirements in the JD.
2. For each, pick the single strongest piece of evidence from the candidate's approved facts, with real numbers.
3. Then write the letter, ~300-340 words, fits on one page.

# TONE
- The voice is polite, humble, and respectful, but not timid or self-deprecating.
- Open exactly with "I'm applying for the [role] role at [company],". Do NOT put "thank you for your consideration" here — save it for the closing.
- Stay modest in framing, but keep the achievements and numbers at full strength. Humble tone, confident facts.

# STRUCTURE
- Paragraph 1: Open with "I'm applying for the [role] role at [company],". Introduce the candidate's strongest relevant skills and background. No gratitude here.
- Paragraph 2: Deep evidence. The single strongest project or experience matching the JD requirements. Numbers, stack, outcome.
- Paragraph 3: One more piece of evidence (shorter), then close with a polite invitation + thank you. Always end the body with: "I'd welcome the chance to discuss how I might contribute, and I'm happy to share more at your convenience. Thank you very much for your time and consideration."
- Then a blank line, then "Best regards," on its own line.

# STYLE
- Sound like a competent, considerate person writing, not a template. Vary sentence length so it breathes.
- Lead with evidence and outcomes. Never state qualities like "strong communicator", "business-minded", "team player", or "passionate". Instead prove them: communication via the tutoring/presenting fact, business sense via having run operations, teamwork via flagging blockers early. Let the reader draw the conclusion.
- Use only facts from the candidate's approved facts. If the JD wants something the candidate doesn't have, lean on the closest real strength rather than faking it.
- Never use the em dash (—). Use commas, periods, parentheses, or colons instead.
- Sign off: "Best regards, Jincheng Deng".

# HARD RULES
- Do NOT use these words: excited, thrilled, passionate, love, eager, incredible, amazing.
- Do NOT inflate seniority. The candidate is early-career.
- Do NOT use the em dash character.
- Salutation: address the hiring team formally (not "Hi" or "Hello").
- Do NOT use corporate jargon. Say what was actually built.`;

const SCHEMA_HINT = `{
  "date": string,
  "recipientBlock": string (company name only, no address/placeholders),
  "salutation": string,
  "bodyParagraphs": [string, string, string],
  "closing": "Best regards,"
}`;

function renderMarkdown(c: TailoredCoverLetter): string {
  const contact = [c.contact.email, c.contact.phone, c.contact.location, c.contact.linkedinDisplay, c.contact.portfolioDisplay].filter(Boolean);
  const lines: string[] = [];
  lines.push(`# ${c.name}`);
  if (contact.length) lines.push(contact.join(' · '));
  lines.push('', c.date, '', c.recipientBlock, '', c.salutation, '');
  for (const p of c.bodyParagraphs) lines.push(p, '');
  lines.push('', c.closing, '', c.name);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function todayPretty(): string {
  return new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Keep only the sign-off line ("Best regards,") from the model's closing.
 * The model often appends the candidate name or a "[Your Name]" placeholder,
 * but renderMarkdown already adds the real name — without this we'd duplicate it.
 * Also strips any trailing candidate name on the closing line itself.
 */
function sanitizeClosing(raw: string | undefined, candidateName: string): string {
  const firstLine = (raw ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  let closing = firstLine && firstLine.length > 0 ? firstLine : 'Best regards,';
  // Strip candidate name if the model appended it to the closing line
  // e.g. "Best regards, Jincheng Deng" → "Best regards,"
  const nameSuffix = new RegExp(`\\s*${candidateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  closing = closing.replace(nameSuffix, '').trimEnd();
  // Ensure it ends with a comma
  if (!closing.endsWith(',')) closing += ',';
  return closing;
}

/**
 * Strip bracket placeholders ([Company Address], [City, State], [Country])
 * that the LLM sometimes generates for the recipient block.
 */
function sanitizeRecipient(raw: string | undefined, company: string): string {
  if (!raw || /\[.*?\]/.test(raw)) {
    return `Hiring Team\n${company}`.trim();
  }
  return raw;
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
    recipientBlock: sanitizeRecipient(tailored.recipientBlock, job.company ?? 'Unknown'),
    salutation: tailored.salutation ?? 'Dear Hiring Team,',
    bodyParagraphs: (tailored.bodyParagraphs ?? []).slice(0, 3),
    closing: sanitizeClosing(tailored.closing, resume.name),
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

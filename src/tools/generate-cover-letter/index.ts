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

const SYSTEM_PROMPT = `You write warm, genuine cover letters (about 250-300 words, 3 body paragraphs) from a real candidate who is sincerely interested in THIS company and THIS role. Tone: polite, enthusiastic, and professional. You are speaking about a candidate you know well — their projects, their skills, their genuine eagerness to contribute. You are given the candidate's résumé bullets and a summary of their background. Use these freely to tell a compelling story.

VOICE (this is critical):
- Open with genuine warmth: state the role, express sincere interest in the company and what they do. Sound like someone who researched the company and is genuinely excited to contribute.
- Lead with the candidate's strengths: their projects, the tech they've built, the problems they've solved. Connect these directly to what the role needs.
- Every paragraph should show alignment between the candidate's skills and the job's tech stack. Be specific about matching technologies and experiences.
- Be naturally confident — the candidate has real projects and real results. Let those speak.
- End with a sincere, warm close. Thank the reader. Express genuine eagerness to join and contribute.

PARAGRAPH 1 — warm opening: state the role, say why the company and this work genuinely interest the candidate. Mention the candidate's background (degree, key skills) and why it's a natural fit. Sound like someone who would be excited to get this job.

PARAGRAPH 2 — strongest tech-stack match: pick the candidate's most relevant project or experience for THIS role. Name specific technologies, describe what was built, and the outcome. Show the reader: "this person has done the kind of work we need."

PARAGRAPH 3 — close with enthusiasm: reaffirm interest in the role and the company. Mention one more skill or quality that would make the candidate a great teammate. Politely invite a conversation. Thank the reader sincerely.

GUIDELINES:
- Feel free to use the candidate's approved facts, educational background, and project details — they are your material.
- Match the job's tech stack where there is genuine overlap. Be specific: name frameworks, tools, approaches.
- Be warm and human. Avoid robotic formality and clichés.
- Do NOT invent skills the candidate does not have. Stick to what's in the approved facts.
- Do NOT inflate titles or seniority. The candidate is early-career and that's perfectly fine.`;

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

// generate-cover-letter — produce a TailoredCoverLetter for one job, then
// render a markdown view from the structured form. Same JSON+md+PDF pattern
// as generate-resume.
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary, MatchAnalysis, Job } from '../../shared/db/types.js';
import { ensureProfile } from '../distill-profile/index.js';
import { summarizeJob } from '../summarize-job/index.js';
import { matchJob } from '../match-job/index.js';
import type { TailoredCoverLetter } from './types.js';

const log = createLogger('generate-cover-letter');

const SYSTEM_PROMPT = `You write SHORT cover letters (under 250 words across 3 body paragraphs). Tone: warm, confident, specific. Rules:

PARAGRAPH 1 — why this role
- Reference one concrete thing from the job description (a product, a problem, a team scope).
- State the candidate's relevant headline framing.

PARAGRAPH 2 — strongest 1-2 fits
- Pull from match.strengths. Cite a specific project, role, or skill from the candidate profile (not "experienced" hand-waving).
- If candidate profile markdown contains multiple framings of the same project, pick the framing closest to this job's domain — do not blend variants.

PARAGRAPH 3 — close
- One sentence on what excites them about this team/company.
- One sentence asking for the conversation. No begging.

NEVER
- Invent facts not in the candidate profile.
- Use clichés ("passionate self-starter", "team player", "results-driven").
- Quote requirements verbatim from the JD.

Output strict JSON in the schema below.`;

const SCHEMA_HINT = `{
  "name": string,
  "contact": {
    "email": string|null, "phone": string|null, "location": string|null,
    "linkedinDisplay": string|null, "portfolioDisplay": string|null
  },
  "date": string,
  "recipientBlock": string,
  "salutation": string,
  "bodyParagraphs": [string, string, string],
  "closing": string
}`;

function renderMarkdown(c: TailoredCoverLetter): string {
  const contact = [
    c.contact.email,
    c.contact.phone,
    c.contact.location,
    c.contact.linkedinDisplay,
    c.contact.portfolioDisplay,
  ].filter(Boolean);
  const lines: string[] = [];
  lines.push(`# ${c.name}`);
  if (contact.length) lines.push(contact.join(' · '));
  lines.push('');
  lines.push(c.date);
  lines.push('');
  lines.push(c.recipientBlock);
  lines.push('');
  lines.push(c.salutation);
  lines.push('');
  for (const p of c.bodyParagraphs) {
    lines.push(p);
    lines.push('');
  }
  lines.push(c.closing);
  lines.push(c.name);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function todayPretty(): string {
  return new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export type GenerateCoverLetterResult = {
  jobId: string;
  outputDir: string;
  jsonPath: string;
  mdPath: string;
  letter: TailoredCoverLetter;
  markdown: string;
};

export type GenerateCoverLetterOptions = {
  /** Force regeneration even if cached. */
  force?: boolean;
};

export async function generateCoverLetter(jobId: string, opts: GenerateCoverLetterOptions = {}): Promise<GenerateCoverLetterResult> {
  const job: Job | null = db.getJob(jobId);
  if (!job) throw new Error(`generate-cover-letter: ${jobId} not in DB. Run seek-extract first.`);

  const summary: JobSummary = await summarizeJob(jobId);
  const match: MatchAnalysis = await matchJob(jobId, { summary });
  const { profile, markdown: profileMd } = await ensureProfile();

  const slug = applicationSlug(job.company, job.title);
  const outputDir = path.join(config.paths.applicationsDir, slug);
  const jsonPath = path.join(outputDir, `${slug}-cover_letter.json`);
  const mdPath = path.join(outputDir, `${slug}-cover_letter.md`);

  if (!opts.force && fs.existsSync(jsonPath) && fs.existsSync(mdPath)) {
    const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as TailoredCoverLetter;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    log.info({ jobId, outputDir }, 'generate-cover-letter: cached output exists');
    return { jobId, outputDir, jsonPath, mdPath, letter: cached, markdown };
  }

  log.info({ jobId, model: config.llm.model }, 'generate-cover-letter: calling LLM');
  const tailored = await callJson<Partial<TailoredCoverLetter>>({
    step: 'generate-cover-letter',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA_HINT}

JOB: ${job.title} @ ${job.company ?? 'Unknown'}
TODAY (use as date): ${todayPretty()}

JOB SUMMARY:
${JSON.stringify(summary, null, 2)}

MATCH ANALYSIS:
${JSON.stringify(match, null, 2)}

CANDIDATE PROFILE (structured):
${JSON.stringify(profile, null, 2)}

CANDIDATE PROFILE MARKDOWN (authoritative for project framing):
${profileMd}`,
  });

  const letter: TailoredCoverLetter = {
    name: tailored.name ?? profile.name,
    contact: {
      email: tailored.contact?.email ?? profile.contact.email,
      phone: tailored.contact?.phone ?? profile.contact.phone,
      location: tailored.contact?.location ?? profile.contact.location,
      linkedinDisplay: tailored.contact?.linkedinDisplay ?? profile.contact.linkedin,
      portfolioDisplay: tailored.contact?.portfolioDisplay ?? profile.contact.website,
    },
    date: tailored.date ?? todayPretty(),
    recipientBlock: tailored.recipientBlock ?? `Hiring Team\n${job.company ?? ''}`.trim(),
    salutation: tailored.salutation ?? 'Dear Hiring Team,',
    bodyParagraphs: (tailored.bodyParagraphs ?? []).slice(0, 4),
    closing: tailored.closing ?? 'Kind regards,',
  };

  if (letter.bodyParagraphs.length === 0) {
    throw new Error('generate-cover-letter: LLM returned no body paragraphs');
  }

  const markdown = renderMarkdown(letter);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(letter, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  db.updateApplicationFields(jobId, {
    coverLetterMd: markdown,
    outputDir,
    generatedAt: new Date().toISOString(),
    model: config.llm.model,
  });

  log.info(
    { jobId, outputDir, paragraphs: letter.bodyParagraphs.length, mdChars: markdown.length },
    'generate-cover-letter: complete',
  );

  return { jobId, outputDir, jsonPath, mdPath, letter, markdown };
}

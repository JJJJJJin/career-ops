// outreach-draft — for a go-worthy JD, draft a short, specific, personalized
// LinkedIn message or email for each contact the user supplies (hiring manager,
// engineering lead, University of Melbourne alumni). Drafting is the LLM's job;
// the user approves and sends. Drafts go to a review queue and are NEVER sent
// automatically. Contacts are supplied manually (per the refactor decision).
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from '../../shared/llm/client.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import { ensureLibrary } from '../../shared/library/parse.js';
import { buildGrounding, validateProse, type ClaimViolation } from '../../shared/grounding/claims.js';
import { summarizeJob } from '../summarize-job/index.js';
import { classifyJd } from '../classify-jd/index.js';

const log = createLogger('outreach-draft');

const MAX_ATTEMPTS = 2;

export type OutreachContact = {
  name: string;
  role?: string | null;
  channel?: 'linkedin' | 'email';
  /** Free-text hint, e.g. "UoM alumnus, ex-Canva" — used to personalize. */
  note?: string | null;
};

export type OutreachDraft = {
  id: number;
  contactName: string;
  contactRole: string | null;
  channel: 'linkedin' | 'email';
  message: string;
  /** True when the message failed grounding twice — queued as needs_review. */
  needsReview?: boolean;
  violations?: ClaimViolation[];
};

const SYSTEM_PROMPT = `You draft a SHORT, specific, polite outreach message from a job seeker to one named contact at a company. Rules:
- LinkedIn: under 90 words. Email: under 140 words plus a one-line subject.
- Open with a genuine, specific reason for reaching out (the role, the team, a shared school if noted).
- Reference ONE concrete, relevant strength from the candidate facts provided — never invent anything not given.
- Ask for a brief chat or to be pointed to the right person. No hard sell, no desperation, no buzzword soup.
- Plain text. Output strict JSON.`;

export type DraftOptions = { defaultChannel?: 'linkedin' | 'email' };

export async function draftOutreach(
  jobId: string,
  contacts: OutreachContact[],
  opts: DraftOptions = {},
): Promise<{ jobId: string; outputDir: string; filePath: string; drafts: OutreachDraft[] }> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`outreach-draft: ${jobId} not in DB. Run seek-extract first.`);
  if (!contacts.length) throw new Error('outreach-draft: provide at least one contact (manual).');

  const summary = await summarizeJob(jobId);
  const cls = await classifyJd(jobId, { summary });
  const { library } = ensureLibrary();

  // Grounding facts — verbatim from the library, so the LLM stays truthful.
  const factBullets = [
    library.summaryVariants[cls.archetype] || library.summaryVariants.backend,
    library.experience[0]?.bullets[0]?.text,
    library.projects.find((p) => p.bullets.some((b) => b.tags.includes(cls.archetype === 'ai-agent' ? 'ai-llm' : 'backend')))?.bullets[0]?.text,
  ].filter((x): x is string => Boolean(x));
  const factsStr = factBullets.join('\n- ');
  const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const grounding = buildGrounding(library, factBullets, { jobTitle: job.title, summary: factBullets[0], today });

  const drafts: OutreachDraft[] = [];
  for (const c of contacts) {
    const channel = c.channel ?? opts.defaultChannel ?? 'linkedin';
    let message = '';
    let violations: ClaimViolation[] = [];
    let ok = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const avoidBlock = violations.length
        ? `\n\nYOUR PREVIOUS DRAFT WAS REJECTED for unsupported claims. Do NOT repeat:\n${violations.map((v) => `- ${v.value} (${v.reason})`).join('\n')}`
        : '';
      const out = await callJson<{ subject?: string; message?: string }>({
        step: 'outreach-draft',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: `Return JSON: { "subject": string, "message": string }  (subject only for email; "" for linkedin)

ROLE: ${job.title} @ ${job.company ?? 'the company'}
WHAT THE ROLE IS ABOUT: ${summary.primaryEmphasis || summary.domain}
CHANNEL: ${channel}

CONTACT: ${c.name}${c.role ? `, ${c.role}` : ''}
CONTACT NOTE: ${c.note ?? '(none)'}

CANDIDATE FACTS (use only these; do not invent numbers, technologies, titles, or seniority):
- ${factsStr}

CANDIDATE NAME: ${library.contact.name}${avoidBlock}`,
      });
      message = channel === 'email' && out.subject ? `Subject: ${out.subject}\n\n${out.message ?? ''}` : (out.message ?? '');
      const result = await validateProse(message, grounding);
      violations = result.violations;
      if (result.ok) { ok = true; break; }
      log.warn({ jobId, contact: c.name, attempt, violations: violations.length }, 'outreach-draft: grounding failed');
    }

    const id = db.insertOutreachDraft({
      jobId,
      contactName: c.name,
      contactRole: c.role ?? null,
      channel,
      draft: message,
      status: ok ? 'pending' : 'needs_review',
    });
    drafts.push({ id, contactName: c.name, contactRole: c.role ?? null, channel, message, needsReview: !ok, violations: ok ? undefined : violations });
  }

  // Write a human-reviewable markdown file alongside the other artefacts.
  const slug = artefactBase(job);
  const outputDir = applicationDir(job);
  const filePath = path.join(outputDir, `${slug}-outreach.md`);
  const md = [
    `# Outreach drafts — ${job.title} @ ${job.company ?? ''}`,
    `_Review queue. Nothing is sent automatically. Edit, then send yourself._`,
    '',
    ...drafts.map((d) => {
      const flag = d.needsReview
        ? `\n\n> ⚠ NEEDS REVIEW — unsupported claims (fix before sending):\n${(d.violations ?? []).map((v) => `> - [${v.category}] ${v.value} (${v.reason})`).join('\n')}`
        : '';
      return `## ${d.contactName}${d.contactRole ? ` — ${d.contactRole}` : ''}  (${d.channel}, draft #${d.id}${d.needsReview ? ', NEEDS_REVIEW' : ''})${flag}\n\n${d.message}\n`;
    }),
  ].join('\n');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, md, 'utf-8');

  log.info({ jobId, drafts: drafts.length }, 'outreach-draft: queued (not sent)');
  return { jobId, outputDir, filePath, drafts };
}

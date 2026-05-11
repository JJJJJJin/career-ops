// generate-resume — produce a TailoredResume (structured JSON) for one job,
// then deterministically render a markdown view from it. The JSON drives the
// HTML→PDF render later; the markdown is what the human reads when reviewing.
//
// Variant-aware: if the candidate's profile.md contained multiple framings of
// the same project, the LLM picks the closest framing for this job rather
// than blending. We pass both the structured profile AND the raw markdown
// so the LLM has the original variant text available.
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary, MatchAnalysis, SeekJob } from '../../shared/db/types.js';
import { ensureProfile } from '../distill-profile/index.js';
import { summarizeJob } from '../summarize-job/index.js';
import { matchJob } from '../match-job/index.js';
import type { TailoredResume } from './types.js';

const log = createLogger('generate-resume');

const SYSTEM_PROMPT = `You generate a tailored resume in STRUCTURED JSON for a specific job. Rules:

CONTENT
- Reorder/emphasize experience and projects most relevant to this job.
- Strengthen wording with strong action verbs. Quantify outcomes ONLY when the candidate provided a number.
- Surface keywordsToEmphasize naturally in highlights — no keyword stuffing.
- Keep the rewritten summary to 2-3 sentences, focused on this role.
- DO NOT invent experience, dates, technologies, or metrics not in the candidate profile.
- Aim for one page worth of content (~400-650 words across all sections combined).

VARIANT-AWARE PROJECT FRAMING
- The candidate may have written multiple framings of the same project for different role targets (e.g. backend version vs AI-engineer version). The CANDIDATE PROFILE MARKDOWN is the AUTHORITATIVE source for project intro paragraphs and highlight phrasing.
- For each project: identify the framing closest to this JOB SUMMARY's domain/seniority (backend, AI/ML, data, embedded, full-stack, etc.). Use that variant's intro paragraph and pick highlights from that variant FIRST.
- You may add 1-2 highlights from other variants if they directly address requirements the chosen variant doesn't cover.
- Do NOT mash variants together by paraphrasing — copy the candidate's actual phrasing where possible.
- Do NOT include all variants of the same project. Pick one framing per project.

INLINE FORMATTING
- Highlights MAY contain inline **bold** to emphasize key terms. Use sparingly (max 1-2 bold spans per bullet).
- Do NOT include other markdown (no italics, no links).

OUTPUT
Return strict JSON in the schema below. All arrays may be empty; fields may be null where unknown. No prose, no markdown fences.`;

const SCHEMA_HINT = `{
  "name": string,
  "contact": {
    "email": string|null, "phone": string|null, "location": string|null,
    "linkedinUrl": string|null, "linkedinDisplay": string|null,
    "portfolioUrl": string|null, "portfolioDisplay": string|null,
    "github": string|null
  },
  "summary": string,
  "competencies": string[],
  "experience": [ { "company": string, "role": string, "period": string, "location": string|null, "highlights": string[] } ],
  "projects": [ { "name": string, "badge": string|null, "description": string, "highlights": string[], "technologies": string[] } ],
  "education": [ { "degree": string, "institution": string, "period": string, "details": string|null } ],
  "certifications": string[],
  "skills": [ { "category": string, "items": string[] } ]
}`;

function deriveBadgeFromDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  if (d.includes('ai') || d.includes('ml')) return 'AI / ML';
  if (d.includes('backend') || d.includes('platform')) return 'Backend';
  if (d.includes('frontend') || d.includes('ui')) return 'Frontend';
  if (d.includes('embedded') || d.includes('firmware')) return 'Embedded';
  if (d.includes('data')) return 'Data';
  return null;
}

function renderMarkdown(r: TailoredResume): string {
  const contactBits = [
    r.contact.email,
    r.contact.phone,
    r.contact.location,
    r.contact.linkedinDisplay ?? r.contact.linkedinUrl,
    r.contact.portfolioDisplay ?? r.contact.portfolioUrl,
    r.contact.github,
  ].filter(Boolean);

  const lines: string[] = [];
  lines.push(`# ${r.name}`);
  if (contactBits.length) lines.push(contactBits.join(' · '));
  lines.push('');

  if (r.summary) {
    lines.push(`> ${r.summary}`);
    lines.push('');
  }

  if (r.competencies.length) {
    lines.push(`**Core competencies:** ${r.competencies.join(' · ')}`);
    lines.push('');
  }

  if (r.experience.length) {
    lines.push('## Experience');
    lines.push('');
    for (const e of r.experience) {
      lines.push(`### ${e.role} — ${e.company}`);
      const sub = [e.period, e.location].filter(Boolean).join(' · ');
      if (sub) lines.push(`*${sub}*`);
      lines.push('');
      for (const h of e.highlights) lines.push(`- ${h}`);
      lines.push('');
    }
  }

  if (r.projects.length) {
    lines.push('## Projects');
    lines.push('');
    for (const p of r.projects) {
      const badge = p.badge ? ` _(${p.badge})_` : '';
      lines.push(`### ${p.name}${badge}`);
      if (p.description) lines.push(p.description);
      if (p.highlights.length) {
        lines.push('');
        for (const h of p.highlights) lines.push(`- ${h}`);
      }
      if (p.technologies.length) {
        lines.push('');
        lines.push(`*Tech:* ${p.technologies.join(', ')}`);
      }
      lines.push('');
    }
  }

  if (r.education.length) {
    lines.push('## Education');
    lines.push('');
    for (const ed of r.education) {
      lines.push(`**${ed.degree}** — ${ed.institution} (${ed.period})`);
      if (ed.details) lines.push(ed.details);
      lines.push('');
    }
  }

  if (r.certifications.length) {
    lines.push('## Certifications');
    lines.push('');
    for (const c of r.certifications) lines.push(`- ${c}`);
    lines.push('');
  }

  if (r.skills.length) {
    lines.push('## Skills');
    lines.push('');
    for (const g of r.skills) {
      lines.push(`**${g.category}:** ${g.items.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export type GenerateResumeResult = {
  jobId: string;
  outputDir: string;
  resumeJsonPath: string;
  resumeMdPath: string;
  resume: TailoredResume;
  markdown: string;
};

export type GenerateResumeOptions = {
  /** Force regeneration even if cached resume exists. */
  force?: boolean;
};

export async function generateResume(jobId: string, opts: GenerateResumeOptions = {}): Promise<GenerateResumeResult> {
  const job: SeekJob | null = db.getJob(jobId);
  if (!job) throw new Error(`generate-resume: ${jobId} not in DB. Run seek-extract first.`);

  const summary: JobSummary = await summarizeJob(jobId);
  const match: MatchAnalysis = await matchJob(jobId, { summary });
  const { profile, markdown: profileMd } = await ensureProfile();

  const slug = applicationSlug(job.company, job.title);
  const outputDir = path.join(config.paths.applicationsDir, slug);
  const resumeJsonPath = path.join(outputDir, `${slug}-resume.json`);
  const resumeMdPath = path.join(outputDir, `${slug}-resume.md`);

  if (!opts.force && fs.existsSync(resumeJsonPath) && fs.existsSync(resumeMdPath)) {
    const cached = JSON.parse(fs.readFileSync(resumeJsonPath, 'utf-8')) as TailoredResume;
    const markdown = fs.readFileSync(resumeMdPath, 'utf-8');
    log.info({ jobId, outputDir }, 'generate-resume: cached output exists (use --force to regenerate)');
    return { jobId, outputDir, resumeJsonPath, resumeMdPath, resume: cached, markdown };
  }

  log.info({ jobId, model: config.llm.model, projects: profile.projects.length }, 'generate-resume: calling LLM');
  const tailored = await callJson<Partial<TailoredResume>>({
    step: 'generate-resume',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA_HINT}

JOB: ${job.title} @ ${job.company ?? 'Unknown'}

JOB SUMMARY:
${JSON.stringify(summary, null, 2)}

MATCH ANALYSIS:
${JSON.stringify(match, null, 2)}

CANDIDATE PROFILE (structured):
${JSON.stringify(profile, null, 2)}

CANDIDATE PROFILE MARKDOWN (authoritative for project framing — pick the variant best matching the job):
${profileMd}`,
    maxTokens: 8192,
  });

  // Backfill defaults so render code never gets undefined.
  const resume: TailoredResume = {
    name: tailored.name ?? profile.name,
    contact: {
      email: tailored.contact?.email ?? profile.contact.email,
      phone: tailored.contact?.phone ?? profile.contact.phone,
      location: tailored.contact?.location ?? profile.contact.location,
      linkedinUrl: tailored.contact?.linkedinUrl ?? profile.contact.linkedin,
      linkedinDisplay: tailored.contact?.linkedinDisplay ?? null,
      portfolioUrl: tailored.contact?.portfolioUrl ?? profile.contact.website,
      portfolioDisplay: tailored.contact?.portfolioDisplay ?? null,
      github: tailored.contact?.github ?? profile.contact.github,
    },
    summary: tailored.summary ?? profile.summary,
    competencies: tailored.competencies ?? [],
    experience: (tailored.experience ?? []).map((e) => ({
      company: e?.company ?? '',
      role: e?.role ?? '',
      period: e?.period ?? '',
      location: e?.location ?? null,
      highlights: e?.highlights ?? [],
    })),
    projects: (tailored.projects ?? []).map((p) => ({
      name: p?.name ?? '',
      badge: p?.badge ?? deriveBadgeFromDomain(summary.domain),
      description: p?.description ?? '',
      highlights: p?.highlights ?? [],
      technologies: p?.technologies ?? [],
    })),
    education: (tailored.education ?? []).map((ed) => ({
      degree: ed?.degree ?? '',
      institution: ed?.institution ?? '',
      period: ed?.period ?? '',
      details: ed?.details ?? null,
    })),
    certifications: tailored.certifications ?? [],
    skills: tailored.skills ?? [],
  };

  const markdown = renderMarkdown(resume);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(resumeJsonPath, JSON.stringify(resume, null, 2), 'utf-8');
  fs.writeFileSync(resumeMdPath, markdown, 'utf-8');

  db.updateApplicationFields(jobId, {
    resumeMd: markdown,
    outputDir,
    generatedAt: new Date().toISOString(),
    model: config.llm.model,
    profileHash: profile.sourceMarkdownHash,
  });

  log.info(
    {
      jobId,
      outputDir,
      experience: resume.experience.length,
      projects: resume.projects.length,
      mdChars: markdown.length,
    },
    'generate-resume: complete',
  );

  return { jobId, outputDir, resumeJsonPath, resumeMdPath, resume, markdown };
}

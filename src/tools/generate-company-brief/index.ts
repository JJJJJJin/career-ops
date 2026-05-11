// generate-company-brief — concise company + role brief to read before
// applying or interviewing. Optionally grounded by web-distill on a company
// website URL so the LLM has fresh content rather than relying purely on
// knowledge-cutoff facts.
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { applicationSlug } from '../../shared/slug.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary, SeekJob } from '../../shared/db/types.js';
import { summarizeJob } from '../summarize-job/index.js';
import { webDistill } from '../web-distill/index.js';

const log = createLogger('generate-company-brief');

const SYSTEM_PROMPT = `You write concise company + role briefings to help a candidate quickly catch up before applying or interviewing. Use what's in the job description first; supplement with general knowledge ONLY when you're confident. Be honest about uncertainty — never fabricate funding, headcount, founders, or recent news. Anything unverified goes into "thingsToVerify".

If the user provided extra COMPANY WEBSITE CONTENT, treat it as authoritative for "what they do" and "products". Quote/paraphrase faithfully; don't extrapolate beyond what's there.

Output strict JSON.`;

const SCHEMA_HINT = `{
  "companyOneLiner": string,
  "whatTheyDo": string,
  "productsOrServices": string[],
  "industryAndMarket": string,
  "cultureAndValues": string,
  "positionContext": string,
  "thingsToVerify": string[]
}`;

type CompanyBrief = {
  companyOneLiner: string;
  whatTheyDo: string;
  productsOrServices: string[];
  industryAndMarket: string;
  cultureAndValues: string;
  positionContext: string;
  thingsToVerify: string[];
};

function renderMarkdown(b: CompanyBrief, job: SeekJob): string {
  const lines: string[] = [];
  lines.push(`# ${job.company ?? 'Company brief'} — ${job.title}`);
  lines.push('');
  if (b.companyOneLiner) {
    lines.push(`> ${b.companyOneLiner}`);
    lines.push('');
  }

  if (b.whatTheyDo) {
    lines.push('## What they do');
    lines.push(b.whatTheyDo);
    lines.push('');
  }

  if (b.productsOrServices.length) {
    lines.push('## Products / services');
    for (const p of b.productsOrServices) lines.push(`- ${p}`);
    lines.push('');
  }

  if (b.industryAndMarket) {
    lines.push('## Industry & market');
    lines.push(b.industryAndMarket);
    lines.push('');
  }

  if (b.cultureAndValues) {
    lines.push('## Culture & values');
    lines.push(b.cultureAndValues);
    lines.push('');
  }

  if (b.positionContext) {
    lines.push('## This role in context');
    lines.push(b.positionContext);
    lines.push('');
  }

  if (b.thingsToVerify.length) {
    lines.push('## Things to verify');
    for (const t of b.thingsToVerify) lines.push(`- [ ] ${t}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export type GenerateCompanyBriefResult = {
  jobId: string;
  outputDir: string;
  mdPath: string;
  brief: CompanyBrief;
  markdown: string;
  groundedBy: string | null;
};

export type GenerateCompanyBriefOptions = {
  /** Optional company website URL to ground the brief. */
  companyWebsite?: string;
  /** Force regeneration. */
  force?: boolean;
};

export async function generateCompanyBrief(jobId: string, opts: GenerateCompanyBriefOptions = {}): Promise<GenerateCompanyBriefResult> {
  const job: SeekJob | null = db.getJob(jobId);
  if (!job) throw new Error(`generate-company-brief: ${jobId} not in DB. Run seek-extract first.`);
  const summary: JobSummary = await summarizeJob(jobId);

  const slug = applicationSlug(job.company, job.title);
  const outputDir = path.join(config.paths.applicationsDir, slug);
  const mdPath = path.join(outputDir, `${slug}-company_brief.md`);
  const jsonPath = path.join(outputDir, `${slug}-company_brief.json`);

  if (!opts.force && fs.existsSync(jsonPath) && fs.existsSync(mdPath)) {
    const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as CompanyBrief;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    log.info({ jobId, outputDir }, 'generate-company-brief: cached output exists');
    return { jobId, outputDir, mdPath, brief: cached, markdown, groundedBy: null };
  }

  let groundingBlock = '';
  let groundedBy: string | null = null;
  if (opts.companyWebsite) {
    log.info({ url: opts.companyWebsite }, 'generate-company-brief: distilling company website');
    try {
      const distilled = await webDistill(opts.companyWebsite);
      groundedBy = opts.companyWebsite;
      groundingBlock = `\n\nCOMPANY WEBSITE CONTENT (treat as authoritative; ${distilled.text.length} chars):\n${distilled.markdown.slice(0, 6000)}`;
    } catch (err) {
      log.warn({ url: opts.companyWebsite, err: (err as Error).message }, 'generate-company-brief: web-distill failed');
    }
  }

  log.info({ jobId, model: config.llm.model, grounded: !!groundedBy }, 'generate-company-brief: calling LLM');
  const out = await callJson<Partial<CompanyBrief>>({
    step: 'generate-company-brief',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA_HINT}

JOB:
- Title: ${job.title}
- Company: ${job.company ?? 'Unknown'}
- Location: ${job.location ?? 'Unknown'}
- Classification: ${job.classification ?? 'Unknown'}

JOB DESCRIPTION (raw):
${job.description}

JOB SUMMARY:
${JSON.stringify(summary, null, 2)}${groundingBlock}`,
  });

  const brief: CompanyBrief = {
    companyOneLiner: out.companyOneLiner ?? '',
    whatTheyDo: out.whatTheyDo ?? '',
    productsOrServices: out.productsOrServices ?? [],
    industryAndMarket: out.industryAndMarket ?? '',
    cultureAndValues: out.cultureAndValues ?? '',
    positionContext: out.positionContext ?? '',
    thingsToVerify: out.thingsToVerify ?? [],
  };

  const markdown = renderMarkdown(brief, job);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(brief, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  db.updateApplicationFields(jobId, {
    companyBriefMd: markdown,
    outputDir,
    generatedAt: new Date().toISOString(),
    model: config.llm.model,
  });

  log.info(
    { jobId, outputDir, products: brief.productsOrServices.length, verifyItems: brief.thingsToVerify.length },
    'generate-company-brief: complete',
  );

  return { jobId, outputDir, mdPath, brief, markdown, groundedBy };
}

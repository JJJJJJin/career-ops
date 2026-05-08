// summarize-job — JD → must-haves / nice-to-haves / tech / seniority.
// Persists to applications.summary_json.
import { callJson } from '../../shared/llm/client.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary } from '../../shared/db/types.js';

const log = createLogger('summarize-job');

const SYSTEM_PROMPT = `You summarize job postings so a candidate can quickly assess fit. Be precise. Distinguish must-haves (explicit requirements) from nice-to-haves (preferred / bonus). Do not invent details that are not in the posting. Output strict JSON.`;

const SCHEMA = `Return JSON: {
  "oneLineSummary": string,
  "responsibilities": string[],
  "mustHaveRequirements": string[],
  "niceToHaveRequirements": string[],
  "techStack": string[],
  "domain": string,
  "seniority": string
}`;

export type SummarizeOptions = {
  /** Skip writing summary to applications row. */
  noStore?: boolean;
  /** Force regeneration even if summary already cached. */
  force?: boolean;
};

export async function summarizeJob(jobId: string, opts: SummarizeOptions = {}): Promise<JobSummary> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`summarize-job: ${jobId} not in DB. Run seek-extract first.`);

  if (!opts.force) {
    const existing = db.getApplication(jobId);
    if (existing?.summary) {
      log.info({ jobId }, 'summarize-job: returning cached summary');
      return existing.summary;
    }
  }

  log.info({ jobId, model: config.llm.model }, 'summarize-job: calling LLM');
  const out = await callJson<Partial<JobSummary>>({
    step: 'summarize-job',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${SCHEMA}

JOB TITLE: ${job.title}
COMPANY: ${job.company ?? 'Unknown'}
LOCATION: ${job.location ?? 'Unknown'}
WORK TYPE: ${job.workType ?? 'Unknown'}
CLASSIFICATION: ${job.classification ?? 'Unknown'}

DESCRIPTION:
${job.description}`,
  });

  const summary: JobSummary = {
    oneLineSummary: out.oneLineSummary ?? '',
    responsibilities: out.responsibilities ?? [],
    mustHaveRequirements: out.mustHaveRequirements ?? [],
    niceToHaveRequirements: out.niceToHaveRequirements ?? [],
    techStack: out.techStack ?? [],
    domain: out.domain ?? '',
    seniority: out.seniority ?? '',
  };

  if (!opts.noStore) {
    db.updateApplicationFields(jobId, { summary, model: config.llm.model });
  }

  log.info(
    {
      jobId,
      mustHaves: summary.mustHaveRequirements.length,
      niceToHaves: summary.niceToHaveRequirements.length,
      tech: summary.techStack.length,
      domain: summary.domain,
      seniority: summary.seniority,
    },
    'summarize-job: complete',
  );

  return summary;
}

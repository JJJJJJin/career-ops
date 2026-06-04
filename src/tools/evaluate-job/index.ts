// evaluate-job — composite of <source>-extract (if needed) + flag-eligibility +
// summarize-job + match-job. The "should I apply?" entry point.
//
// Eligibility hard-fails to NOT_FOR_YOU regardless of LLM score, so we save
// LLM tokens by short-circuiting before summarize/match.
//
// Source-agnostic: auto-detects SEEK vs LinkedIn from the URL via the
// JobSource registry, or looks up the stored source by jobId.
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { EligibilityFlag, Job, JobSummary, MatchAnalysis } from '../../shared/db/types.js';
import { detectSource, sourceForJobId } from '../../shared/jobs/registry.js';
import { flagEligibility } from '../flag-eligibility/index.js';
import { summarizeJob } from '../summarize-job/index.js';
import { matchJob } from '../match-job/index.js';
import { ensureLibrary } from '../../shared/library/parse.js';

const log = createLogger('evaluate-job');

export type EvaluateOptions = {
  reextract?: boolean;
  force?: boolean;
};

export type EvaluateResult = {
  job: Job;
  eligibility: { flags: EligibilityFlag[]; isEligible: boolean };
  summary: JobSummary | null;
  match: MatchAnalysis;
};

const NOT_FOR_YOU: MatchAnalysis = {
  fitScore: 0,
  scoreOutOf5: 0,
  recommendation: 'NOT_FOR_YOU',
  oneLineFit: 'Filtered by eligibility heuristics — see flags.',
  strengths: [],
  gaps: [],
  transferableSkills: [],
  keywordsToEmphasize: [],
};

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export async function evaluateJob(jobIdOrUrl: string, opts: EvaluateOptions = {}): Promise<EvaluateResult> {
  // Step 1: ensure we have a full Job in the DB. Dispatch through the registry
  // so SEEK / LinkedIn / future sources all work without changing this code.
  let job: Job;
  if (isUrl(jobIdOrUrl)) {
    const source = detectSource(jobIdOrUrl);
    if (!source) {
      throw new Error(
        `evaluate-job: no job source matches URL "${jobIdOrUrl}". ` +
          `Supported: SEEK (seek.com.au), LinkedIn (linkedin.com), Indeed (indeed.*), Built In (builtin.com).`,
      );
    }
    log.info({ source: source.name, url: jobIdOrUrl }, 'evaluate-job: dispatching to source');
    job = await source.extract(jobIdOrUrl, { reextract: opts.reextract });
  } else {
    const cached = db.getJob(jobIdOrUrl);
    if (cached && cached.description.length > 0) {
      job = cached;
    } else {
      const source = sourceForJobId(jobIdOrUrl);
      throw new Error(
        `evaluate-job: ${jobIdOrUrl} not in DB. ` +
          `Either pass a full URL or run \`career-ops ${source.name}-extract <url>\` first.`,
      );
    }
  }

  // Step 2: eligibility heuristics. Short-circuit if any flag fires.
  const eligibility = flagEligibility({ jobId: job.jobId });
  log.info(
    { jobId: job.jobId, source: job.source, isEligible: eligibility.isEligible, flags: eligibility.flags.map((f) => f.flag) },
    'evaluate-job: eligibility scan complete',
  );

  if (!eligibility.isEligible) {
    db.updateApplicationFields(job.jobId, {
      recommendation: 'NOT_FOR_YOU',
      fitScore: 0,
      scoreOutOf5: 0,
      oneLineFit: NOT_FOR_YOU.oneLineFit,
      match: NOT_FOR_YOU,
    });
    return {
      job: { ...job, eligibilityFlags: eligibility.flags },
      eligibility,
      summary: null,
      match: NOT_FOR_YOU,
    };
  }

  // Step 3: summarize, match.
  const summary = await summarizeJob(job.jobId, { force: opts.force });
  const match = await matchJob(job.jobId, { force: opts.force, summary });

  // Step 4: record tech-stack gaps for every evaluated job (drives the learning roadmap).
  // Cheap — deterministic string matching, no LLM.
  try {
    const { library } = ensureLibrary();
    const libBlob = [
      ...library.experience.flatMap((e) => e.bullets.map((b) => b.text)),
      ...library.projects.flatMap((p) => [...p.bullets.map((b) => b.text), ...p.tech, p.role ?? '']),
      ...library.skills.flatMap((g) => g.items),
    ].join(' \n ').toLowerCase();
    const gaps: Array<{ requirement: string; kind: string }> = [];
    for (const tech of summary.techStack) {
      const t = tech.toLowerCase().trim();
      if (!t) continue;
      if (!new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(libBlob)) {
        gaps.push({ requirement: tech, kind: 'tech' });
      }
    }
    if (gaps.length) db.recordGaps(job.jobId, gaps);
  } catch (err) {
    log.warn({ jobId: job.jobId, err: (err as Error).message }, 'evaluate-job: gap recording skipped');
  }

  return {
    job: { ...job, eligibilityFlags: eligibility.flags },
    eligibility,
    summary,
    match,
  };
}

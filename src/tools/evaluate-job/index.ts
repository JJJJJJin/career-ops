// evaluate-job — composite of seek-extract (if needed) + flag-eligibility +
// summarize-job + match-job. The "should I apply?" entry point.
//
// Eligibility hard-fails to NOT_FOR_YOU regardless of LLM score, so we save
// LLM tokens by short-circuiting before summarize/match.
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { EligibilityFlag, JobSummary, MatchAnalysis, SeekJob } from '../../shared/db/types.js';
import { extractJobIdFromUrl, seekExtract } from '../seek-extract/index.js';
import { flagEligibility } from '../flag-eligibility/index.js';
import { summarizeJob } from '../summarize-job/index.js';
import { matchJob } from '../match-job/index.js';

const log = createLogger('evaluate-job');

export type EvaluateOptions = {
  /** Force re-extraction (bypass cache). */
  reextract?: boolean;
  /** Force re-evaluation (re-summarize + re-match) even if cached. */
  force?: boolean;
};

export type EvaluateResult = {
  job: SeekJob;
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
  // Step 1: ensure we have a full SeekJob in the DB.
  let job: SeekJob;
  if (isUrl(jobIdOrUrl)) {
    job = await seekExtract(jobIdOrUrl, { reextract: opts.reextract });
  } else {
    const cached = db.getJob(jobIdOrUrl);
    if (cached && cached.description.length > 0) {
      job = cached;
    } else {
      throw new Error(
        `evaluate-job: ${jobIdOrUrl} not in DB. Either pass a full SEEK URL or run \`career-ops seek-extract <url>\` first.`,
      );
    }
  }

  // Step 2: eligibility heuristics. Short-circuit if any flag fires.
  const eligibility = flagEligibility({ jobId: job.jobId });
  log.info(
    { jobId: job.jobId, isEligible: eligibility.isEligible, flags: eligibility.flags.map((f) => f.flag) },
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

  return {
    job: { ...job, eligibilityFlags: eligibility.flags },
    eligibility,
    summary,
    match,
  };
}

export { extractJobIdFromUrl };

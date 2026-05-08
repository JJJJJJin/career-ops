// daily-pipeline — scan SEEK with config keywords, evaluate every new
// job, then auto-apply (generate + render) for STRONG matches up to a cap.
//
// Designed to be triggered manually or via cron. Eligibility blocks short-
// circuit before any LLM spending.
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { writeTracker } from '../shared/db/view.js';
import { db } from '../shared/db/store.js';
import { seekSearch } from '../tools/seek-search/index.js';
import { seekExtract } from '../tools/seek-extract/index.js';
import { evaluateJob } from '../tools/evaluate-job/index.js';
import { applyJob } from './apply-job.js';

const log = createLogger('workflow:daily-pipeline');

export type DailyPipelineOptions = {
  /** Override SEEK search keywords. */
  keywords?: string[];
  /** Auto-apply (generate resume/cover letter/PDFs) for the top N STRONG matches. 0 = evaluate only. */
  autoApplyTopN?: number;
  /** Force re-evaluation of cached jobs. */
  force?: boolean;
};

export type DailyPipelineResult = {
  scanned: number;
  newJobs: number;
  evaluated: number;
  strongMatches: number;
  applied: number;
  trackerPath: string;
};

export async function runDailyPipeline(opts: DailyPipelineOptions = {}): Promise<DailyPipelineResult> {
  const t0 = Date.now();
  const autoApplyN = opts.autoApplyTopN ?? 0;

  log.info({ autoApplyN }, 'daily-pipeline: stage 1 — scan');
  const searchResults = await seekSearch({ keywords: opts.keywords });
  const newJobs = searchResults.filter((r) => r.isNew);
  log.info({ found: searchResults.length, isNew: newJobs.length }, 'daily-pipeline: scan complete');

  // Stage 2: extract + evaluate every new job (sequential to avoid hammering SEEK).
  log.info({ count: newJobs.length }, 'daily-pipeline: stage 2 — extract + evaluate new jobs');
  let evaluated = 0;
  let strongMatches = 0;
  for (const r of newJobs) {
    try {
      // Ensure full job description is in DB before eligibility/summary calls.
      await seekExtract(r.url);
      const result = await evaluateJob(r.jobId, { force: opts.force });
      evaluated += 1;
      if (result.match.recommendation === 'STRONG') strongMatches += 1;
    } catch (err) {
      log.warn({ jobId: r.jobId, err: (err as Error).message }, 'daily-pipeline: evaluation failed (skipping)');
    }
  }

  // Stage 3: auto-apply top N STRONG matches (descending score).
  let applied = 0;
  if (autoApplyN > 0) {
    log.info({ autoApplyN }, 'daily-pipeline: stage 3 — auto-apply STRONG matches');
    const top = db.listJobs({
      sinceDays: config.search.days,
      eligibleOnly: true,
      minScore: config.scoring.strongThreshold,
      limit: autoApplyN,
    });
    for (const { job, application } of top) {
      if (application?.recommendation !== 'STRONG') continue;
      try {
        await applyJob(job.jobId, { force: opts.force });
        applied += 1;
      } catch (err) {
        log.warn({ jobId: job.jobId, err: (err as Error).message }, 'daily-pipeline: apply-job failed (skipping)');
      }
    }
  }

  const trackerPath = writeTracker();

  log.info(
    {
      scanned: searchResults.length,
      newJobs: newJobs.length,
      evaluated,
      strongMatches,
      applied,
      totalMs: Date.now() - t0,
    },
    'daily-pipeline: complete',
  );

  return {
    scanned: searchResults.length,
    newJobs: newJobs.length,
    evaluated,
    strongMatches,
    applied,
    trackerPath,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  let autoApplyTopN = 0;
  let force = false;
  let keywords: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-apply-top') {
      autoApplyTopN = parseInt(argv[i + 1] ?? '0', 10);
      i++;
    } else if (a === '--force') force = true;
    else if (a === '-q' || a === '--keyword') {
      keywords = (keywords ?? []).concat(argv[i + 1] ?? '');
      i++;
    }
  }

  const r = await runDailyPipeline({ autoApplyTopN, force, keywords });
  process.stdout.write(`\n  scan:        ${r.scanned} jobs (${r.newJobs} new)\n`);
  process.stdout.write(`  evaluated:   ${r.evaluated}\n`);
  process.stdout.write(`  STRONG:      ${r.strongMatches}\n`);
  process.stdout.write(`  applied:     ${r.applied}\n`);
  process.stdout.write(`  tracker:     ${r.trackerPath}\n`);
}

// daily-pipeline — scan a job source with config keywords, evaluate every
// new job, then auto-apply (generate + render) for STRONG matches up to a cap.
//
// Defaults to SEEK; pass --source linkedin (or both) to scan elsewhere.
// Designed to be triggered manually or via cron. Eligibility blocks short-
// circuit before any LLM spending.
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { writeTracker } from '../shared/db/view.js';
import { db } from '../shared/db/store.js';
import { getSource } from '../shared/jobs/registry.js';
import type { JobSourceName } from '../shared/db/types.js';
import { evaluateJob } from '../tools/evaluate-job/index.js';
import { applyJob } from './apply-job.js';

const log = createLogger('workflow:daily-pipeline');

export type DailyPipelineOptions = {
  /** Override search keywords. */
  keywords?: string[];
  /** Which platforms to scan. Defaults to ['seek']. */
  sources?: JobSourceName[];
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
  const sources = opts.sources ?? ['seek'];

  // Stage 1: scan each requested source.
  log.info({ autoApplyN, sources }, 'daily-pipeline: stage 1 — scan');
  const searchResults = [];
  for (const name of sources) {
    const source = getSource(name);
    if (!source.search) {
      log.warn({ source: name }, 'daily-pipeline: source does not support search, skipping');
      continue;
    }
    const r = await source.search({ keywords: opts.keywords });
    searchResults.push(...r);
  }
  const newJobs = searchResults.filter((r) => r.isNew);
  log.info({ found: searchResults.length, isNew: newJobs.length }, 'daily-pipeline: scan complete');

  // Stage 2: extract + evaluate every new job (sequential to avoid hammering sources).
  log.info({ count: newJobs.length }, 'daily-pipeline: stage 2 — extract + evaluate new jobs');
  let evaluated = 0;
  let strongMatches = 0;
  for (const r of newJobs) {
    try {
      // evaluate-job extracts via the source registry when given a URL.
      const result = await evaluateJob(r.url, { force: opts.force });
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
  let sources: JobSourceName[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-apply-top') {
      autoApplyTopN = parseInt(argv[i + 1] ?? '0', 10);
      i++;
    } else if (a === '--force') force = true;
    else if (a === '-q' || a === '--keyword') {
      keywords = (keywords ?? []).concat(argv[i + 1] ?? '');
      i++;
    } else if (a === '--source') {
      const v = (argv[i + 1] ?? '').trim();
      if (v === 'seek' || v === 'linkedin' || v === 'indeed' || v === 'builtin') sources = (sources ?? []).concat(v);
      else throw new Error(`--source must be 'seek', 'linkedin', 'indeed', or 'builtin', got '${v}'`);
      i++;
    }
  }

  const r = await runDailyPipeline({ autoApplyTopN, force, keywords, sources });
  process.stdout.write(`\n  scan:        ${r.scanned} jobs (${r.newJobs} new)\n`);
  process.stdout.write(`  evaluated:   ${r.evaluated}\n`);
  process.stdout.write(`  STRONG:      ${r.strongMatches}\n`);
  process.stdout.write(`  applied:     ${r.applied}\n`);
  process.stdout.write(`  tracker:     ${r.trackerPath}\n`);
}

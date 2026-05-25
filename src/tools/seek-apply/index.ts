// seek-apply — orchestrate SEEK applications (single + batch).
//
// Pipeline per job: resolve artefacts → (external? record + skip) → rotate-upload
// the tailored resume → drive quick-apply → record outcome in the DB.
//
// SUBMISSION IS DOUBLE-GATED: a real "Submit application" click happens only
// when invoked with --submit AND config.seek.allowSubmit (SEEK_ALLOW_SUBMIT)
// is true. By default every run is a dry-run that stops at the review page.
import fs from 'node:fs';
import path from 'node:path';
import { closeSession, launchSession, type BrowserSession } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { applicationDir, applicationSlug } from '../../shared/slug.js';
import { ensureLoggedIn } from '../../shared/seek/auth.js';
import { rotateUploadResume } from '../../shared/seek/documents.js';
import { runQuickApply, type QuickApplyStep } from '../../shared/seek/quick-apply.js';
import { extractJobIdFromUrl } from '../seek-extract/index.js';

const log = createLogger('seek-apply');

export type SeekApplyOptions = {
  /** Opt in to actually submitting. Still requires SEEK_ALLOW_SUBMIT=true. */
  submit?: boolean;
  headful?: boolean;
};

export type SeekApplyResult = {
  jobId: string;
  title?: string;
  applyMethod: 'quick' | 'external';
  stoppedAt?: QuickApplyStep;
  screenshotPath?: string;
  externalUrl?: string;
  note?: string;
  unanswered?: string[];
  newQuestions?: string[];
  guidelinePath?: string;
};

function composeCoverLetter(jsonPath: string): string | undefined {
  if (!fs.existsSync(jsonPath)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as { salutation?: string; bodyParagraphs?: string[]; closing?: string };
    const parts = [j.salutation, ...(j.bodyParagraphs ?? []), j.closing].filter(Boolean) as string[];
    return parts.length ? parts.join('\n\n') : undefined;
  } catch {
    return undefined;
  }
}

/** Core per-job flow given an already-logged-in session. */
async function applyOneJob(session: BrowserSession, jobId: string, dryRun: boolean): Promise<SeekApplyResult> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`${jobId} not in DB. Run \`career-ops apply-job ${jobId}\` first.`);
  if (job.source !== 'seek') throw new Error(`seek-apply only supports SEEK jobs (got source=${job.source}).`);

  const slug = applicationSlug(job.company, job.title);
  const dir = applicationDir(job);
  const resumePdf = path.join(dir, `${slug}-resume.pdf`);
  if (!fs.existsSync(resumePdf)) throw new Error(`resume PDF missing: ${resumePdf}. Run \`career-ops apply-job ${jobId}\` first.`);
  const coverText = composeCoverLetter(path.join(dir, `${slug}-cover_letter.json`));

  // External postings: record for manual submission, don't drive a wizard.
  if (job.applyType === 'external') {
    const url = job.externalApplyUrl ?? job.url;
    db.updateApplicationFields(jobId, { applyMethod: 'external', applyState: 'external_pending', notes: `External apply — submit manually: ${url}` });
    log.info({ jobId, url }, 'external apply — recorded for manual submission');
    return { jobId, title: job.title, applyMethod: 'external', externalUrl: url, note: 'External application — open the URL and submit manually.' };
  }

  const { filename, deleted } = await rotateUploadResume(session, resumePdf);
  if (deleted) log.info({ jobId, deleted }, 'rotated out oldest resume to free a slot');

  const result = await runQuickApply(session, jobId, { resumeFilename: filename, coverLetterText: coverText, dryRun });
  log.info({ jobId, stoppedAt: result.stoppedAt, answered: result.answered?.length ?? 0, unanswered: result.unanswered?.length ?? 0 }, 'quick-apply finished');

  // Record outcome. applied_at + status=applied ONLY on a real submission.
  const fields: Parameters<typeof db.updateApplicationFields>[1] = { applyMethod: 'quick', applyResumePath: resumePdf };
  if (result.answered?.length) fields.applyAnswers = result.answered;
  if (result.stoppedAt === 'submitted') {
    fields.applyState = 'submitted';
    fields.appliedAt = new Date().toISOString();
  } else if (result.stoppedAt === 'review') {
    fields.applyState = 'filled_pending_review';
  } else {
    fields.applyError = result.stoppedAt === 'questions' ? `stopped: ${result.unanswered?.length ?? 0} unanswered question(s)` : `stopped at ${result.stoppedAt}`;
  }
  db.updateApplicationFields(jobId, fields);
  if (result.stoppedAt === 'submitted') db.setStatus(jobId, 'applied', 'auto-applied via SEEK quick apply');

  return {
    jobId,
    title: job.title,
    applyMethod: 'quick',
    stoppedAt: result.stoppedAt,
    screenshotPath: result.screenshotPath,
    unanswered: result.unanswered,
    newQuestions: result.newQuestions,
    guidelinePath: result.guidelinePath,
  };
}

function isDryRun(submit?: boolean): boolean {
  // Never submit unless BOTH the per-run flag and the master switch are set.
  return !(submit && config.seek.allowSubmit);
}

export async function seekApply(jobIdOrUrl: string, opts: SeekApplyOptions = {}): Promise<SeekApplyResult> {
  const jobId = extractJobIdFromUrl(jobIdOrUrl);
  const dryRun = isDryRun(opts.submit);
  const session = await launchSession({ headless: opts.headful ? false : config.browser.headless, storageStatePath: config.seek.authStatePath });
  try {
    await ensureLoggedIn(session);
    return await applyOneJob(session, jobId, dryRun);
  } finally {
    await closeSession(session);
  }
}

export type SeekApplyBatchOptions = SeekApplyOptions & { minScore?: number; maxApplies?: number };

export type SeekApplyBatchResult = {
  candidates: number;
  dryRun: boolean;
  results: SeekApplyResult[];
};

/** Auto-apply to eligible STRONG SEEK jobs not yet applied to. One shared login. */
export async function seekApplyBatch(opts: SeekApplyBatchOptions = {}): Promise<SeekApplyBatchResult> {
  const minScore = opts.minScore ?? config.seek.applyMinScore;
  const maxApplies = opts.maxApplies ?? config.seek.maxAppliesPerRun;
  const dryRun = isDryRun(opts.submit);

  const candidates = db
    .listJobs({ source: 'seek', eligibleOnly: true, minScore })
    .filter(({ application }) => application?.recommendation === 'STRONG')
    .filter(({ application }) => !application || application.status === 'new' || application.status === 'interested')
    .filter(({ application }) => application?.applyState !== 'submitted')
    .slice(0, maxApplies);

  log.info({ candidates: candidates.length, minScore, maxApplies, dryRun }, 'seek-apply batch: starting');

  const results: SeekApplyResult[] = [];
  if (!candidates.length) return { candidates: 0, dryRun, results };

  const session = await launchSession({ headless: opts.headful ? false : config.browser.headless, storageStatePath: config.seek.authStatePath });
  try {
    await ensureLoggedIn(session);
    for (const { job } of candidates) {
      try {
        results.push(await applyOneJob(session, job.jobId, dryRun));
      } catch (err) {
        log.warn({ jobId: job.jobId, err: (err as Error).message }, 'seek-apply batch: job failed (skipping)');
        results.push({ jobId: job.jobId, title: job.title, applyMethod: 'quick', note: `error: ${(err as Error).message}` });
      }
    }
  } finally {
    await closeSession(session);
  }
  return { candidates: candidates.length, dryRun, results };
}

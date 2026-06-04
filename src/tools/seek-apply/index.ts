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
import * as tracker from '../../shared/tracker/index.js';
import { createLogger } from '../../shared/logger.js';
import { applicationDir, artefactBase } from '../../shared/slug.js';
import { journal } from '../../shared/agent/journal.js';
import { ensureLoggedIn } from '../../shared/seek/auth.js';
import { rotateUploadResume } from '../../shared/seek/documents.js';
import { runQuickApply, type QuickApplyStep, type SubmitMode } from '../../shared/seek/quick-apply.js';
import { extractJobIdFromUrl } from '../seek-extract/index.js';
import { applyJob } from '../../workflows/apply-job.js';

const log = createLogger('seek-apply');

export type SeekApplyOptions = {
  /** Auto-submit without asking. Still requires SEEK_ALLOW_SUBMIT=true. */
  submit?: boolean;
  /** Pause at the review page and ask before submitting each job. */
  confirm?: boolean;
  headful?: boolean;
};

/** dry (default) → confirm (--confirm) → auto (--submit + SEEK_ALLOW_SUBMIT). */
function resolveSubmitMode(opts: { submit?: boolean; confirm?: boolean }): SubmitMode {
  if (opts.confirm) return 'confirm';
  if (opts.submit && config.seek.allowSubmit) return 'auto';
  return 'dry';
}

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
  /** Path to the persistent run trace (reports/agent-runs/…). */
  journalPath?: string;
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
async function applyOneJob(session: BrowserSession, jobId: string, submitMode: SubmitMode): Promise<SeekApplyResult> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`${jobId} not in DB. Run \`career-ops apply-job ${jobId}\` first.`);
  if (job.source !== 'seek') throw new Error(`seek-apply only supports SEEK jobs (got source=${job.source}).`);

  journal.section(`job ${jobId}: ${job.title ?? ''}`, { company: job.company ?? undefined, applyType: job.applyType ?? 'unknown', submitMode });

  const slug = artefactBase(job);
  const dir = applicationDir(job);
  const resumePdf = path.join(dir, `${slug}-resume.pdf`);
  if (!fs.existsSync(resumePdf)) throw new Error(`resume PDF missing: ${resumePdf}. Run \`career-ops apply-job ${jobId}\` first.`);
  const coverText = composeCoverLetter(path.join(dir, `${slug}-cover-letter.json`));

  // External postings: record for manual submission, don't drive a wizard.
  if (job.applyType === 'external') {
    const url = job.externalApplyUrl ?? job.url;
    db.updateApplicationFields(jobId, { applyMethod: 'external', applyState: 'external_pending', notes: `External apply — submit manually: ${url}` });
    log.info({ jobId, url }, 'external apply — recorded for manual submission');
    journal.note('external apply — recorded for manual submission', { url });
    return { jobId, title: job.title, applyMethod: 'external', externalUrl: url, note: 'External application — open the URL and submit manually.' };
  }

  const { filename, deleted } = await rotateUploadResume(session, resumePdf);
  if (deleted) log.info({ jobId, deleted }, 'rotated out oldest resume to free a slot');

  const result = await runQuickApply(session, jobId, { resumeFilename: filename, coverLetterText: coverText, submitMode, jobTitle: job.title ?? undefined });
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
  if (result.stoppedAt === 'submitted') {
    db.setStatus(jobId, 'applied', 'auto-applied via SEEK quick apply');
    // Mirror the successful submit to the shared tracker (queues if offline).
    await tracker.recordStatus(
      { source: job.source, sourceId: job.jobId, company: job.company, title: job.title, url: job.url },
      '已申请',
      { appliedAt: fields.appliedAt, notes: 'auto-applied via SEEK quick apply' },
    );
  }
  journal.note(`outcome: stopped at ${result.stoppedAt}`, { applyState: fields.applyState, applyError: fields.applyError, screenshot: result.screenshotPath });

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

export async function seekApply(jobIdOrUrl: string, opts: SeekApplyOptions = {}): Promise<SeekApplyResult> {
  const jobId = extractJobIdFromUrl(jobIdOrUrl);
  const submitMode = resolveSubmitMode(opts);
  const tracePath = journal.start(`seek-apply-${jobId}-${Date.now()}`, { jobId, submitMode, allowSubmit: config.seek.allowSubmit });
  try {
    const session = await launchSession({ headless: opts.headful ? false : config.browser.headless, storageStatePath: config.seek.authStatePath });
    try {
      await ensureLoggedIn(session);
      const r = await applyOneJob(session, jobId, submitMode);
      journal.end({ stoppedAt: r.stoppedAt, applyMethod: r.applyMethod });
      return { ...r, journalPath: tracePath ?? undefined };
    } finally {
      await closeSession(session);
    }
  } catch (err) {
    journal.fail('seek-apply aborted', { jobId, error: (err as Error).message });
    journal.end({ aborted: true });
    throw err;
  }
}

export type SeekApplyBatchOptions = SeekApplyOptions & { minScore?: number; maxApplies?: number };

export type SeekApplyBatchResult = {
  candidates: number;
  dryRun: boolean;
  results: SeekApplyResult[];
  journalPath?: string;
};

/** Auto-apply to eligible STRONG SEEK jobs not yet applied to. One shared login. */
export async function seekApplyBatch(opts: SeekApplyBatchOptions = {}): Promise<SeekApplyBatchResult> {
  const minScore = opts.minScore ?? config.seek.applyMinScore;
  const maxApplies = opts.maxApplies ?? config.seek.maxAppliesPerRun;
  const submitMode = resolveSubmitMode(opts);
  const dryRun = submitMode === 'dry';

  const candidates = db
    .listJobs({ source: 'seek', eligibleOnly: true, minScore })
    .filter(({ application }) => application?.recommendation === 'STRONG')
    .filter(({ application }) => !application || application.status === 'new' || application.status === 'interested')
    .filter(({ application }) => application?.applyState !== 'submitted')
    .slice(0, maxApplies);

  log.info({ candidates: candidates.length, minScore, maxApplies, submitMode }, 'seek-apply batch: starting');
  const tracePath = journal.start(`seek-apply-batch-${Date.now()}`, { candidates: candidates.length, minScore, maxApplies, submitMode, allowSubmit: config.seek.allowSubmit });

  const results: SeekApplyResult[] = [];
  if (!candidates.length) {
    journal.note('no candidates matched (STRONG + eligible + not yet applied)');
    journal.end({ candidates: 0 });
    return { candidates: 0, dryRun, results, journalPath: tracePath ?? undefined };
  }

  const session = await launchSession({ headless: opts.headful ? false : config.browser.headless, storageStatePath: config.seek.authStatePath });
  try {
    await ensureLoggedIn(session);
    for (const { job } of candidates) {
      try {
        results.push(await applyOneJob(session, job.jobId, submitMode));
      } catch (err) {
        log.warn({ jobId: job.jobId, err: (err as Error).message }, 'seek-apply batch: job failed (skipping)');
        journal.fail(`job ${job.jobId} aborted`, { error: (err as Error).message });
        results.push({ jobId: job.jobId, title: job.title, applyMethod: 'quick', note: `error: ${(err as Error).message}` });
      }
    }
  } finally {
    await closeSession(session);
  }
  journal.end({ processed: results.length });
  return { candidates: candidates.length, dryRun, results, journalPath: tracePath ?? undefined };
}

export type FileApplyResult = SeekApplyResult & { url: string; prep?: 'ready' | 'skipped-eligibility' | 'prepare-failed' };
export type SeekApplyFileResult = { urls: number; submitMode: SubmitMode; results: FileApplyResult[]; journalPath?: string };

/** Read a .txt of SEEK job URLs (one per line; # comments allowed) and, for each:
 *  generate artefacts (apply-job) then quick-apply. Externals are recorded for
 *  manual submission. One shared login for all the quick-applies. */
export async function seekApplyFromFile(filePath: string, opts: SeekApplyOptions = {}): Promise<SeekApplyFileResult> {
  if (!fs.existsSync(filePath)) throw new Error(`URL list not found: ${filePath}`);
  const urls = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const submitMode = resolveSubmitMode(opts);
  const tracePath = journal.start(`seek-apply-file-${Date.now()}`, { file: filePath, urls: urls.length, submitMode, allowSubmit: config.seek.allowSubmit });
  const results: FileApplyResult[] = [];

  // Phase 1: generate tailored artefacts per URL (apply-job uses its own
  // transient browsers for extract + PDF render; no login needed).
  const ready: Array<{ url: string; jobId: string; title?: string }> = [];
  for (const url of urls) {
    journal.section(`prepare ${url}`);
    try {
      const r = await applyJob(url, { email: false });
      if (r.skippedDueToEligibility) {
        journal.note('skipped — eligibility blocked');
        results.push({ url, jobId: r.jobId, applyMethod: 'quick', prep: 'skipped-eligibility', note: 'eligibility blocked — not auto-applied' });
        continue;
      }
      journal.note('artefacts ready', { jobId: r.jobId });
      ready.push({ url, jobId: r.jobId });
    } catch (err) {
      journal.fail('prepare failed', { url, error: (err as Error).message });
      results.push({ url, jobId: url, applyMethod: 'quick', prep: 'prepare-failed', note: `prepare failed: ${(err as Error).message}` });
    }
  }

  // Phase 2: one shared login; quick-apply each prepared job.
  if (ready.length) {
    const session = await launchSession({ headless: opts.headful ? false : config.browser.headless, storageStatePath: config.seek.authStatePath });
    try {
      await ensureLoggedIn(session);
      for (const { url, jobId } of ready) {
        try {
          const r = await applyOneJob(session, jobId, submitMode);
          results.push({ ...r, url, prep: 'ready' });
        } catch (err) {
          journal.fail(`apply failed ${jobId}`, { error: (err as Error).message });
          results.push({ url, jobId, applyMethod: 'quick', prep: 'ready', note: `apply failed: ${(err as Error).message}` });
        }
      }
    } finally {
      await closeSession(session);
    }
  }

  journal.end({ urls: urls.length, applied: results.length });
  return { urls: urls.length, submitMode, results, journalPath: tracePath ?? undefined };
}

// seek-apply — orchestrate a single SEEK application.
//
// Phase 4 scope: resolve artefacts → log in → rotate-upload the tailored resume
// → drive the quick-apply documents step → stop at the review page (dry-run).
// External-apply jobs are reported for manual submission. Real submission,
// employer-question answering, batch mode, and DB recording arrive in later
// phases.
import fs from 'node:fs';
import path from 'node:path';
import { closeSession, launchSession } from '../../shared/browser/session.js';
import { config } from '../../shared/config.js';
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import { applicationDir, applicationSlug } from '../../shared/slug.js';
import { ensureLoggedIn } from '../../shared/seek/auth.js';
import { rotateUploadResume } from '../../shared/seek/documents.js';
import { runQuickApply, type QuickApplyStep } from '../../shared/seek/quick-apply.js';
import { extractJobIdFromUrl } from '../seek-extract/index.js';

const log = createLogger('seek-apply');

export type SeekApplyOptions = { dryRun?: boolean; headful?: boolean };

export type SeekApplyResult = {
  jobId: string;
  applyMethod: 'quick' | 'external';
  stoppedAt?: QuickApplyStep;
  screenshotPath?: string;
  externalUrl?: string;
  note?: string;
};

/** Compose the cover-letter body for SEEK's textarea (no name/contact header). */
function composeCoverLetter(jsonPath: string): string | undefined {
  if (!fs.existsSync(jsonPath)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as {
      salutation?: string;
      bodyParagraphs?: string[];
      closing?: string;
    };
    const parts = [j.salutation, ...(j.bodyParagraphs ?? []), j.closing].filter(Boolean) as string[];
    return parts.length ? parts.join('\n\n') : undefined;
  } catch {
    return undefined;
  }
}

export async function seekApply(jobIdOrUrl: string, opts: SeekApplyOptions = {}): Promise<SeekApplyResult> {
  const dryRun = opts.dryRun ?? true;
  const jobId = extractJobIdFromUrl(jobIdOrUrl);
  const job = db.getJob(jobId);
  if (!job) throw new Error(`${jobId} not in DB. Run \`career-ops apply-job ${jobIdOrUrl}\` first to generate artefacts.`);
  if (job.source !== 'seek') throw new Error(`seek-apply only supports SEEK jobs (got source=${job.source}).`);

  const slug = applicationSlug(job.company, job.title);
  const dir = applicationDir(job);
  const resumePdf = path.join(dir, `${slug}-resume.pdf`);
  if (!fs.existsSync(resumePdf)) {
    throw new Error(`resume PDF missing: ${resumePdf}. Run \`career-ops apply-job ${jobId}\` first.`);
  }
  const coverText = composeCoverLetter(path.join(dir, `${slug}-cover_letter.json`));

  // External-apply postings can't be quick-applied — record for manual submit.
  if (job.applyType === 'external') {
    log.info({ jobId, url: job.externalApplyUrl ?? job.url }, 'external apply — recording for manual submission');
    return {
      jobId,
      applyMethod: 'external',
      externalUrl: job.externalApplyUrl ?? job.url,
      note: 'External application — open the URL and submit manually.',
    };
  }

  const session = await launchSession({
    headless: opts.headful ? false : config.browser.headless,
    storageStatePath: config.seek.authStatePath,
  });
  try {
    await ensureLoggedIn(session);
    const { filename, deleted } = await rotateUploadResume(session, resumePdf);
    if (deleted) log.info({ deleted }, 'rotated out oldest resume to free a slot');

    const result = await runQuickApply(session, jobId, { resumeFilename: filename, coverLetterText: coverText, dryRun });
    log.info({ jobId, stoppedAt: result.stoppedAt, steps: result.steps }, 'quick-apply finished');
    return {
      jobId,
      applyMethod: 'quick',
      stoppedAt: result.stoppedAt,
      screenshotPath: result.screenshotPath,
    };
  } finally {
    await closeSession(session);
  }
}

// apply-job — single-job full pipeline.
//
// Chains: evaluate-job → (parallel) generate-{resume, cover-letter,
// company-brief} → (parallel) render-{resume, cover-letter}-pdf →
// render-tracker.
//
// Eligibility short-circuits to NOT_FOR_YOU and aborts before any LLM
// generation calls — saves tokens.
import { createLogger } from '../shared/logger.js';
import { writeTracker } from '../shared/db/view.js';
import { evaluateJob } from '../tools/evaluate-job/index.js';
import { generateResume } from '../tools/generate-resume/index.js';
import { generateCoverLetter } from '../tools/generate-cover-letter/index.js';
import { generateCompanyBrief } from '../tools/generate-company-brief/index.js';
import { renderResumePdf } from '../tools/render-resume-pdf/index.js';
import { renderCoverLetterPdf } from '../tools/render-cover-letter-pdf/index.js';

const log = createLogger('workflow:apply-job');

export type ApplyOptions = {
  /** Skip generating a brief / rendering PDFs / etc. for fast iterations. */
  skipBrief?: boolean;
  skipPdf?: boolean;
  /** Force re-extraction or regeneration. */
  reextract?: boolean;
  force?: boolean;
  /** Optional company website to ground the company-brief LLM call. */
  companyWebsite?: string;
};

export type ApplyResult = {
  jobId: string;
  recommendation: string;
  scoreOutOf5: number;
  outputDir: string | null;
  artefacts: {
    resumeMd?: string;
    resumePdf?: string;
    coverLetterMd?: string;
    coverLetterPdf?: string;
    companyBriefMd?: string;
  };
  trackerPath: string;
  skippedDueToEligibility: boolean;
};

export async function applyJob(jobIdOrUrl: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const t0 = Date.now();

  log.info({ jobIdOrUrl }, 'apply-job: stage 1 — evaluate');
  const evaluation = await evaluateJob(jobIdOrUrl, { reextract: opts.reextract, force: opts.force });
  const jobId = evaluation.job.jobId;

  if (!evaluation.eligibility.isEligible) {
    log.warn({ jobId, flags: evaluation.eligibility.flags.map((f) => f.flag) }, 'apply-job: eligibility blocked — skipping generation');
    const trackerPath = writeTracker();
    return {
      jobId,
      recommendation: 'NOT_FOR_YOU',
      scoreOutOf5: 0,
      outputDir: null,
      artefacts: {},
      trackerPath,
      skippedDueToEligibility: true,
    };
  }

  log.info({ jobId, score: evaluation.match.scoreOutOf5, recommendation: evaluation.match.recommendation }, 'apply-job: stage 2 — generate (parallel)');

  const tasks: Array<Promise<unknown>> = [
    generateResume(jobId, { force: opts.force }),
    generateCoverLetter(jobId, { force: opts.force }),
  ];
  if (!opts.skipBrief) {
    tasks.push(generateCompanyBrief(jobId, { force: opts.force, companyWebsite: opts.companyWebsite }));
  }

  const [resumeRes, coverRes, briefRes] = await Promise.all(tasks) as [
    Awaited<ReturnType<typeof generateResume>>,
    Awaited<ReturnType<typeof generateCoverLetter>>,
    Awaited<ReturnType<typeof generateCompanyBrief>> | undefined,
  ];

  let resumePdf: string | undefined;
  let coverLetterPdf: string | undefined;
  if (!opts.skipPdf) {
    log.info({ jobId }, 'apply-job: stage 3 — render PDFs (parallel)');
    [resumePdf, coverLetterPdf] = await Promise.all([renderResumePdf(jobId), renderCoverLetterPdf(jobId)]);
  }

  const trackerPath = writeTracker();

  log.info(
    { jobId, totalMs: Date.now() - t0, outputDir: resumeRes.outputDir },
    'apply-job: complete',
  );

  return {
    jobId,
    recommendation: evaluation.match.recommendation,
    scoreOutOf5: evaluation.match.scoreOutOf5,
    outputDir: resumeRes.outputDir,
    artefacts: {
      resumeMd: resumeRes.resumeMdPath,
      resumePdf,
      coverLetterMd: coverRes.mdPath,
      coverLetterPdf,
      companyBriefMd: briefRes?.mdPath,
    },
    trackerPath,
    skippedDueToEligibility: false,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let force = false;
  let reextract = false;
  let skipBrief = false;
  let skipPdf = false;
  let companyWebsite: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--skip-brief') skipBrief = true;
    else if (a === '--skip-pdf') skipPdf = true;
    else if (a === '--company-website' || a === '--url') {
      companyWebsite = argv[i + 1];
      i++;
    } else if (a && !a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops apply-job <jobIdOrUrl> [--force] [--reextract] [--skip-brief] [--skip-pdf] [--company-website <url>]');
    process.exit(2);
  }

  const r = await applyJob(jobIdOrUrl, { force, reextract, skipBrief, skipPdf, companyWebsite });

  if (r.skippedDueToEligibility) {
    process.stdout.write(`🚫 ${r.jobId} skipped — eligibility blocked. See \`career-ops show-job ${r.jobId}\` for details.\n`);
    return;
  }
  process.stdout.write(`\n✔ ${r.jobId}  ${r.recommendation}  ${r.scoreOutOf5}/5\n`);
  process.stdout.write(`  → ${r.outputDir}\n`);
  if (r.artefacts.resumePdf) process.stdout.write(`     resume.pdf\n`);
  if (r.artefacts.coverLetterPdf) process.stdout.write(`     cover_letter.pdf\n`);
  if (r.artefacts.companyBriefMd) process.stdout.write(`     company_brief.md\n`);
  process.stdout.write(`\n  tracker: ${r.trackerPath}\n`);
}

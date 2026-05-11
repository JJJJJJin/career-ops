// apply-job — single-job full pipeline.
//
// Chains: evaluate-job → (parallel) generate-{resume, cover-letter,
// company-brief} → (parallel) render-{resume, cover-letter}-pdf →
// render-tracker.
//
// Eligibility short-circuits to NOT_FOR_YOU and aborts before any LLM
// generation calls — saves tokens.
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { writeTracker } from '../shared/db/view.js';
import { evaluateJob } from '../tools/evaluate-job/index.js';
import { generateResume } from '../tools/generate-resume/index.js';
import { generateCoverLetter } from '../tools/generate-cover-letter/index.js';
import { generateCompanyBrief } from '../tools/generate-company-brief/index.js';
import { renderResumePdf } from '../tools/render-resume-pdf/index.js';
import { renderCoverLetterPdf } from '../tools/render-cover-letter-pdf/index.js';
import { renderCompanyBriefPdf } from '../tools/render-company-brief-pdf/index.js';
import { sendEmail, isEmailConfigured } from '../shared/email/send.js';

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
  /** Email the generated PDF bundle to EMAIL_TO. Default: on when email is configured. */
  email?: boolean;
  /** Override the recipient (otherwise uses EMAIL_TO). */
  emailTo?: string;
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
    companyBriefPdf?: string;
  };
  trackerPath: string;
  skippedDueToEligibility: boolean;
  emailedTo?: string;
  emailedFiles?: string[];
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
  let companyBriefPdf: string | undefined;
  if (!opts.skipPdf) {
    log.info({ jobId, includeBrief: !!briefRes }, 'apply-job: stage 3 — render PDFs (parallel)');
    const pdfTasks: Array<Promise<string>> = [renderResumePdf(jobId), renderCoverLetterPdf(jobId)];
    if (briefRes) pdfTasks.push(renderCompanyBriefPdf(jobId));
    const pdfs = await Promise.all(pdfTasks);
    [resumePdf, coverLetterPdf, companyBriefPdf] = pdfs as [string, string, string | undefined];
  }

  const trackerPath = writeTracker();

  // Stage 4 — email the PDF bundle to your personal inbox. Default on
  // when EMAIL_USER + EMAIL_APP_PASSWORD + EMAIL_TO are all set in .env;
  // disabled with --no-email. Never fatal: delivery failures don't void
  // a successful generation.
  let emailedFiles: string[] | undefined;
  let emailedTo: string | undefined;
  const wantEmail = opts.email ?? isEmailConfigured();
  if (wantEmail && !opts.skipPdf) {
    const filesToSend = [resumePdf, coverLetterPdf, companyBriefPdf].filter(Boolean) as string[];
    if (filesToSend.length) {
      try {
        log.info({ jobId, count: filesToSend.length }, 'apply-job: stage 4 — emailing bundle');
        const company = evaluation.job.company ?? 'Unknown company';
        const subject = `${company} — ${evaluation.job.title}  ·  ${evaluation.match.scoreOutOf5}/5 ${evaluation.match.recommendation}`;
        const body = [
          `Job: ${evaluation.job.title}`,
          `Company: ${company}`,
          `Location: ${evaluation.job.location ?? 'n/a'}`,
          `Fit: ${evaluation.match.scoreOutOf5}/5  (${evaluation.match.recommendation})`,
          evaluation.job.url ? `URL: ${evaluation.job.url}` : '',
          '',
          `Attached: ${filesToSend.map((f) => f.split('/').pop()).join(', ')}`,
          '',
          `— career-ops`,
        ].filter(Boolean).join('\n');
        const result = await sendEmail({
          subject,
          text: body,
          attachments: filesToSend.map((p) => ({ path: p })),
          to: opts.emailTo,
        });
        emailedFiles = filesToSend;
        emailedTo = (result.accepted[0] ?? opts.emailTo);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'apply-job: email delivery failed (non-fatal)');
      }
    }
  }

  log.info(
    { jobId, totalMs: Date.now() - t0, outputDir: resumeRes.outputDir, emailed: emailedFiles?.length ?? 0 },
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
      companyBriefPdf,
    },
    trackerPath,
    skippedDueToEligibility: false,
    emailedTo,
    emailedFiles,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let force = false;
  let reextract = false;
  let skipBrief = false;
  let skipPdf = false;
  let companyWebsite: string | undefined;
  let email: boolean | undefined;
  let emailTo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--skip-brief') skipBrief = true;
    else if (a === '--skip-pdf') skipPdf = true;
    else if (a === '--email') email = true;
    else if (a === '--no-email') email = false;
    else if (a === '--email-to') {
      emailTo = argv[i + 1];
      i++;
    } else if (a === '--company-website' || a === '--url') {
      companyWebsite = argv[i + 1];
      i++;
    } else if (a && !a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops apply-job <jobIdOrUrl> [--force] [--reextract] [--skip-brief] [--skip-pdf] [--company-website <url>] [--email | --no-email] [--email-to <addr>]');
    process.exit(2);
  }

  const r = await applyJob(jobIdOrUrl, { force, reextract, skipBrief, skipPdf, companyWebsite, email, emailTo });

  if (r.skippedDueToEligibility) {
    process.stdout.write(`🚫 ${r.jobId} skipped — eligibility blocked. See \`career-ops show-job ${r.jobId}\` for details.\n`);
    return;
  }
  process.stdout.write(`\n✔ ${r.jobId}  ${r.recommendation}  ${r.scoreOutOf5}/5\n`);
  process.stdout.write(`  → ${r.outputDir}\n`);
  if (r.artefacts.resumePdf) process.stdout.write(`     ${path.basename(r.artefacts.resumePdf)}\n`);
  if (r.artefacts.coverLetterPdf) process.stdout.write(`     ${path.basename(r.artefacts.coverLetterPdf)}\n`);
  if (r.artefacts.companyBriefPdf) process.stdout.write(`     ${path.basename(r.artefacts.companyBriefPdf)}\n`);
  if (r.artefacts.companyBriefMd) process.stdout.write(`     ${path.basename(r.artefacts.companyBriefMd)}\n`);
  if (r.emailedFiles && r.emailedFiles.length) {
    process.stdout.write(`\n  📧 emailed ${r.emailedFiles.length} file(s)${r.emailedTo ? ` → ${r.emailedTo}` : ''}\n`);
  }
  process.stdout.write(`\n  tracker: ${r.trackerPath}\n`);
}

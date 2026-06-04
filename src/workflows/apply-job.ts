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
import { assembleResume } from '../tools/assemble-resume/index.js';
import { goNoGo, type GoNoGoDecision } from '../tools/go-no-go/index.js';
import { recordJobGaps } from '../tools/gap-report/index.js';
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
  /** Assemble + render even when the go/no-go gate marks the JD low-yield. */
  applyAnyway?: boolean;
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
  /** Go/no-go gate flagged the JD low-yield and generation was skipped. */
  skippedDueToLowYield?: boolean;
  goNoGo?: GoNoGoDecision;
  /** Cover letter failed grounding twice → routed to review, no clean letter/PDF. */
  coverLetterNeedsReview?: boolean;
  /** Company brief had unsourced facts after retry → banner added. */
  companyBriefNeedsReview?: boolean;
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

  // Stage 1.5 — go/no-go gate. Compare the JD's hard must-haves against the
  // real profile. A low-yield JD is surfaced (with reasons + recorded gaps) and
  // generation is skipped by default, so we don't spend a cycle pretending to
  // match. Override with --apply-anyway.
  const summary = evaluation.summary ?? undefined;
  const decision = await goNoGo(jobId, { summary });
  if (decision.decision === 'low-yield' && !opts.applyAnyway) {
    if (summary) recordJobGaps(jobId, summary, { unmetRequirements: [] }, decision.reasons);
    log.warn({ jobId, reasons: decision.reasons.map((r) => r.kind) }, 'apply-job: low-yield — skipping generation (use --apply-anyway to override)');
    const trackerPath = writeTracker();
    return {
      jobId,
      recommendation: evaluation.match.recommendation,
      scoreOutOf5: evaluation.match.scoreOutOf5,
      outputDir: null,
      artefacts: {},
      trackerPath,
      skippedDueToEligibility: false,
      skippedDueToLowYield: true,
      goNoGo: decision,
    };
  }

  // Assemble the résumé FIRST — it is the grounding source for the cover letter
  // (selected bullets + chosen summary), so it must exist before the letter is
  // drafted and validated.
  log.info({ jobId, score: evaluation.match.scoreOutOf5, recommendation: evaluation.match.recommendation }, 'apply-job: stage 2a — assemble résumé (deterministic)');
  const resumeRes = await assembleResume(jobId, { force: opts.force, summary });
  if (summary) recordJobGaps(jobId, summary, resumeRes.report, decision.reasons);

  log.info({ jobId }, 'apply-job: stage 2b — cover letter + company brief (grounded, parallel)');
  const [coverRes, briefRes] = await Promise.all([
    generateCoverLetter(jobId, { force: opts.force }),
    opts.skipBrief
      ? Promise.resolve(undefined)
      : generateCompanyBrief(jobId, { force: opts.force, companyWebsite: opts.companyWebsite }),
  ]) as [Awaited<ReturnType<typeof generateCoverLetter>>, Awaited<ReturnType<typeof generateCompanyBrief>> | undefined];

  if (coverRes.needsReview) {
    log.warn({ jobId, violations: coverRes.violations?.length }, 'apply-job: cover letter routed to NEEDS_REVIEW — no clean letter/PDF emitted');
  }

  let resumePdf: string | undefined;
  let coverLetterPdf: string | undefined;
  let companyBriefPdf: string | undefined;
  if (!opts.skipPdf) {
    // Never render a PDF for a cover letter that failed grounding.
    const renderCover = !coverRes.needsReview;
    log.info({ jobId, includeBrief: !!briefRes, renderCover }, 'apply-job: stage 3 — render PDFs');
    resumePdf = await renderResumePdf(jobId);
    const [coverPdf, briefPdf] = await Promise.all([
      renderCover ? renderCoverLetterPdf(jobId) : Promise.resolve(undefined),
      briefRes ? renderCompanyBriefPdf(jobId) : Promise.resolve(undefined),
    ]);
    coverLetterPdf = coverPdf;
    companyBriefPdf = briefPdf;
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
      coverLetterMd: coverRes.needsReview ? coverRes.reviewPath : coverRes.mdPath,
      coverLetterPdf,
      companyBriefMd: briefRes?.mdPath,
      companyBriefPdf,
    },
    trackerPath,
    skippedDueToEligibility: false,
    coverLetterNeedsReview: coverRes.needsReview,
    companyBriefNeedsReview: briefRes?.needsReview,
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
  let applyAnyway = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--skip-brief') skipBrief = true;
    else if (a === '--skip-pdf') skipPdf = true;
    else if (a === '--apply-anyway') applyAnyway = true;
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
    console.error('Usage: career-ops apply-job <jobIdOrUrl> [--force] [--reextract] [--skip-brief] [--skip-pdf] [--apply-anyway] [--company-website <url>] [--email | --no-email] [--email-to <addr>]');
    process.exit(2);
  }

  const r = await applyJob(jobIdOrUrl, { force, reextract, skipBrief, skipPdf, companyWebsite, email, emailTo, applyAnyway });

  if (r.skippedDueToEligibility) {
    process.stdout.write(`🚫 ${r.jobId} skipped — eligibility blocked. See \`career-ops show-job ${r.jobId}\` for details.\n`);
    return;
  }
  if (r.skippedDueToLowYield) {
    process.stdout.write(`⚠ ${r.jobId} low-yield — generation skipped (run with --apply-anyway to override):\n`);
    for (const reason of r.goNoGo?.reasons ?? []) process.stdout.write(`    - [${reason.kind}] ${reason.detail}\n`);
    process.stdout.write(`\n  Recorded to gap report. See \`career-ops gap-report\`.\n`);
    return;
  }
  process.stdout.write(`\n✔ ${r.jobId}  ${r.recommendation}  ${r.scoreOutOf5}/5\n`);
  process.stdout.write(`  → ${r.outputDir}\n`);
  if (r.coverLetterNeedsReview) {
    process.stdout.write(`  ⚠ cover letter had unsupported claims after retry → NEEDS_REVIEW file, no PDF. Review: ${r.artefacts.coverLetterMd}\n`);
  }
  if (r.companyBriefNeedsReview) {
    process.stdout.write(`  ⚠ company brief has unsourced facts (banner added) — verify before relying.\n`);
  }
  if (r.artefacts.resumePdf) process.stdout.write(`     ${path.basename(r.artefacts.resumePdf)}\n`);
  if (r.artefacts.coverLetterPdf) process.stdout.write(`     ${path.basename(r.artefacts.coverLetterPdf)}\n`);
  if (r.artefacts.companyBriefPdf) process.stdout.write(`     ${path.basename(r.artefacts.companyBriefPdf)}\n`);
  if (r.artefacts.companyBriefMd) process.stdout.write(`     ${path.basename(r.artefacts.companyBriefMd)}\n`);
  if (r.emailedFiles && r.emailedFiles.length) {
    process.stdout.write(`\n  📧 emailed ${r.emailedFiles.length} file(s)${r.emailedTo ? ` → ${r.emailedTo}` : ''}\n`);
  }
  process.stdout.write(`\n  tracker: ${r.trackerPath}\n`);
}

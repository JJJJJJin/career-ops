// gen-brief — self-contained: evaluate → generate company brief → render PDF.
import path from 'node:path';
import { config } from '../../src/shared/config.js';
import { evaluateJob } from '../../src/tools/evaluate-job/index.js';
import { generateCompanyBrief } from '../../src/tools/generate-company-brief/index.js';
import { renderCompanyBriefPdf } from '../../src/tools/render-company-brief-pdf/index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let force = false;
  let reextract = false;
  let skipPdf = false;
  let companyWebsite: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--skip-pdf') skipPdf = true;
    else if (a === '--company-website' || a === '--url') {
      companyWebsite = argv[i + 1];
      i++;
    } else if (!a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops gen-brief <jobIdOrUrl> [--force] [--reextract] [--skip-pdf] [--company-website <url>]');
    process.exit(2);
  }

  // Stage 1 — evaluate
  const ev = await evaluateJob(jobIdOrUrl, { reextract, force });
  if (!ev.eligibility.isEligible) {
    const hardFlags = ev.eligibility.flags.map(f => f.flag).join(', ');
    process.stderr.write(`✘ ${ev.job.jobId} not eligible — blocked by: ${hardFlags || 'unknown'}\n`);
    process.exit(1);
  }

  // Stage 2 — generate company brief
  const brief = await generateCompanyBrief(ev.job.jobId, { force, companyWebsite });

  // Stage 3 — render PDF
  let pdfPath: string | undefined;
  if (!skipPdf) {
    pdfPath = await renderCompanyBriefPdf(ev.job.jobId);
  }

  process.stdout.write(`\n✔ ${ev.job.jobId}  company brief generated  ${ev.job.company} — ${ev.job.title}\n`);
  process.stdout.write(`  markdown: ${path.relative(config.repoRoot, brief.mdPath)}\n`);
  if (pdfPath) process.stdout.write(`  pdf:      ${path.basename(pdfPath)}\n`);
  if (brief.needsReview) {
    process.stdout.write(`  ⚠ unsourced facts — banner added, verify before relying\n`);
  }
}

export { runCli as default };

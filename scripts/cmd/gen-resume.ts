// gen-resume — self-contained: evaluate → assemble → render PDF.
// Same as the resume leg inside apply-job, but you can call it directly.
import path from 'node:path';
import { config } from '../../src/shared/config.js';
import { evaluateJob } from '../../src/tools/evaluate-job/index.js';
import { assembleResume } from '../../src/tools/assemble-resume/index.js';
import { renderResumePdf } from '../../src/tools/render-resume-pdf/index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let force = false;
  let reextract = false;
  let skipPdf = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--skip-pdf') skipPdf = true;
    else if (!a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops gen-resume <jobIdOrUrl> [--force] [--reextract] [--skip-pdf]');
    process.exit(2);
  }

  // Stage 1 — evaluate
  const ev = await evaluateJob(jobIdOrUrl, { reextract, force });
  if (!ev.eligibility.isEligible) {
    const hardFlags = ev.eligibility.flags.map(f => f.flag).join(', ');
    process.stderr.write(`✘ ${ev.job.jobId} not eligible — blocked by: ${hardFlags || 'unknown'}\n`);
    process.exit(1);
  }

  // Stage 2 — assemble résumé
  const resume = await assembleResume(ev.job.jobId, { force, summary: ev.summary ?? undefined });

  // Stage 3 — render PDF
  let pdfPath: string | undefined;
  if (!skipPdf) {
    pdfPath = await renderResumePdf(ev.job.jobId);
  }

  process.stdout.write(`\n✔ ${ev.job.jobId}  résumé assembled  ${ev.job.company} — ${ev.job.title}\n`);
  process.stdout.write(`  archetype: ${resume.report.archetype}\n`);
  process.stdout.write(`  markdown: ${path.relative(config.repoRoot, resume.resumeMdPath)}\n`);
  if (pdfPath) process.stdout.write(`  pdf:      ${path.basename(pdfPath)}\n`);
  process.stdout.write(`  unmet JD items: ${resume.report.unmetRequirements.length}\n`);
}

export { runCli as default };

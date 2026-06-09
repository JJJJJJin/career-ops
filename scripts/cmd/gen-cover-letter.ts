// gen-cover-letter — self-contained: evaluate → generate cover letter → render PDF.
import path from 'node:path';
import { config } from '../../src/shared/config.js';
import { evaluateJob } from '../../src/tools/evaluate-job/index.js';
import { generateCoverLetter } from '../../src/tools/generate-cover-letter/index.js';
import { renderCoverLetterPdf } from '../../src/tools/render-cover-letter-pdf/index.js';

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
    console.error('Usage: career-ops gen-cover-letter <jobIdOrUrl> [--force] [--reextract] [--skip-pdf]');
    process.exit(2);
  }

  // Stage 1 — evaluate
  const ev = await evaluateJob(jobIdOrUrl, { reextract, force });
  if (!ev.eligibility.isEligible) {
    const hardFlags = ev.eligibility.flags.map(f => f.flag).join(', ');
    process.stderr.write(`✘ ${ev.job.jobId} not eligible — blocked by: ${hardFlags || 'unknown'}\n`);
    process.exit(1);
  }

  // Stage 2 — generate cover letter
  const cover = await generateCoverLetter(ev.job.jobId, { force });

  // Stage 3 — render PDF
  let pdfPath: string | undefined;
  if (!skipPdf) {
    pdfPath = await renderCoverLetterPdf(ev.job.jobId);
  }

  process.stdout.write(`\n✔ ${ev.job.jobId}  cover letter generated  ${ev.job.company} — ${ev.job.title}\n`);
  process.stdout.write(`  paragraphs: ${cover.letter.bodyParagraphs.length}\n`);
  process.stdout.write(`  markdown: ${path.relative(config.repoRoot, cover.mdPath)}\n`);
  if (pdfPath) process.stdout.write(`  pdf:      ${path.basename(pdfPath)}\n`);
  if (cover.warnings?.length) {
    process.stdout.write(`  ⚠ ${cover.warnings.length} grounding warning(s) — PDF generated anyway\n`);
  }
}

export { runCli as default };

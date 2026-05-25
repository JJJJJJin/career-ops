import { seekApply } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let headful = false;
  for (const a of argv) {
    if (a === '--headful' || a === '--headed') headful = true;
    else if (!a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops seek-apply <jobIdOrUrl> [--headful]\n  (Phase 4: dry-run only — fills documents and stops at the review page; never submits.)');
    process.exit(2);
  }

  const r = await seekApply(jobIdOrUrl, { dryRun: true, headful });

  if (r.applyMethod === 'external') {
    process.stdout.write(`\n🔗 ${r.jobId} — external apply. Submit manually at:\n   ${r.externalUrl}\n`);
    return;
  }
  process.stdout.write(`\n✔ ${r.jobId} — quick-apply dry-run stopped at: ${r.stoppedAt}\n`);
  if (r.screenshotPath) process.stdout.write(`   screenshot: ${r.screenshotPath}\n`);
  if (r.stoppedAt === 'review') process.stdout.write(`   (documents filled; review page reached — not submitted)\n`);
  else if (r.stoppedAt === 'questions') process.stdout.write(`   (reached employer questions — Phase 5 will answer these)\n`);
}

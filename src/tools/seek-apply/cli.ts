import { config } from '../../shared/config.js';
import { seekApply, seekApplyBatch, type SeekApplyResult } from './index.js';

function printOne(r: SeekApplyResult): void {
  if (r.applyMethod === 'external') {
    process.stdout.write(`  🔗 ${r.jobId} ${r.title ?? ''} — EXTERNAL, submit manually: ${r.externalUrl}\n`);
    return;
  }
  if (r.note) {
    process.stdout.write(`  ⚠ ${r.jobId} ${r.title ?? ''} — ${r.note}\n`);
    return;
  }
  const mark = r.stoppedAt === 'submitted' ? '✅ SUBMITTED' : r.stoppedAt === 'review' ? '📝 filled, review reached (not submitted)' : r.stoppedAt === 'questions' ? `❓ ${r.unanswered?.length ?? 0} unanswered question(s)` : `⏸ stopped at ${r.stoppedAt}`;
  process.stdout.write(`  ${mark}  ${r.jobId} ${r.title ?? ''}\n`);
  if (r.stoppedAt === 'questions' && r.unanswered?.length) {
    for (const q of r.unanswered) process.stdout.write(`       • ${q}\n`);
    if (r.guidelinePath) process.stdout.write(`       fill answers in ${r.guidelinePath} and re-run\n`);
  }
  if (r.screenshotPath) process.stdout.write(`       screenshot: ${r.screenshotPath}\n`);
}

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let batch = false;
  let submit = false;
  let headful = false;
  let minScore: number | undefined;
  let maxApplies: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') batch = true;
    else if (a === '--submit') submit = true;
    else if (a === '--headful' || a === '--headed') headful = true;
    else if (a === '--min-score') { minScore = parseFloat(argv[++i] ?? ''); }
    else if (a === '--max-applies') { maxApplies = parseInt(argv[++i] ?? '', 10); }
    else if (a && !a.startsWith('--')) jobIdOrUrl = a;
  }

  // Surface the submit gate so it's never a surprise.
  if (submit && !config.seek.allowSubmit) {
    process.stdout.write('⚠ --submit ignored: SEEK_ALLOW_SUBMIT is not true (test mode). Stopping at review, not submitting.\n');
  }

  if (batch) {
    const r = await seekApplyBatch({ submit, headful, minScore, maxApplies });
    process.stdout.write(`\nseek-apply batch — ${r.candidates} candidate(s), ${r.dryRun ? 'DRY-RUN (no submit)' : 'SUBMIT mode'}\n`);
    for (const res of r.results) printOne(res);
    const submitted = r.results.filter((x) => x.stoppedAt === 'submitted').length;
    const review = r.results.filter((x) => x.stoppedAt === 'review').length;
    const ext = r.results.filter((x) => x.applyMethod === 'external').length;
    const needQ = r.results.filter((x) => x.stoppedAt === 'questions').length;
    process.stdout.write(`\nsummary: ${submitted} submitted · ${review} filled/pending · ${ext} external · ${needQ} need answers\n`);
    return;
  }

  if (!jobIdOrUrl) {
    console.error('Usage:\n  career-ops seek-apply <jobIdOrUrl> [--submit] [--headful]\n  career-ops seek-apply --batch [--min-score N] [--max-applies M] [--submit] [--headful]\n\n  Submission requires --submit AND SEEK_ALLOW_SUBMIT=true; otherwise dry-run (stops at review).');
    process.exit(2);
  }

  const r = await seekApply(jobIdOrUrl, { submit, headful });
  printOne(r);
}

import { config } from '../../src/shared/config.js';
import { seekApply, seekApplyBatch, seekApplyFromFile, type SeekApplyResult } from '../../src/tools/seek-apply/index.js';

function printOne(r: SeekApplyResult): void {
  if (r.applyMethod === 'external') {
    process.stdout.write(`  🔗 ${r.jobId} ${r.title ?? ''} — EXTERNAL, submit manually: ${r.externalUrl}\n`);
    return;
  }
  if (r.note) {
    process.stdout.write(`  ⚠ ${r.jobId} ${r.title ?? ''} — ${r.note}\n`);
    return;
  }
  const mark =
    r.stoppedAt === 'submitted' ? '✅ SUBMITTED' :
    r.stoppedAt === 'review' ? '📝 filled, review reached (not submitted)' :
    r.stoppedAt === 'questions' ? `❓ ${r.unanswered?.length ?? 0} unanswered question(s)` :
    `⏸ stopped at ${r.stoppedAt}`;
  process.stdout.write(`  ${mark}  ${r.jobId} ${r.title ?? ''}\n`);
  if (r.stoppedAt === 'questions' && r.unanswered?.length) {
    for (const q of r.unanswered) process.stdout.write(`       • ${q}\n`);
    if (r.guidelinePath) process.stdout.write(`       fill answers in ${r.guidelinePath} and re-run\n`);
  }
  if (r.screenshotPath) process.stdout.write(`       screenshot: ${r.screenshotPath}\n`);
}

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let file: string | undefined;
  let batch = false;
  let submit = false;
  let confirm = false;
  let headful = false;
  let minScore: number | undefined;
  let maxApplies: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch') batch = true;
    else if (a === '--file') file = argv[++i];
    else if (a === '--submit') submit = true;
    else if (a === '--confirm') confirm = true;
    else if (a === '--headful' || a === '--headed') headful = true;
    else if (a === '--min-score') minScore = parseFloat(argv[++i] ?? '');
    else if (a === '--max-applies') maxApplies = parseInt(argv[++i] ?? '', 10);
    else if (a && !a.startsWith('--')) jobIdOrUrl = a;
  }

  if (submit && !config.seek.allowSubmit) {
    process.stdout.write('⚠ --submit ignored: SEEK_ALLOW_SUBMIT is not true (test mode). Use --confirm to approve each, or set the env var.\n');
  }

  // ── from a URL list file ──────────────────────────────────────────────
  if (file) {
    const r = await seekApplyFromFile(file, { submit, confirm, headful });
    process.stdout.write(`\nseek-apply from ${file} — ${r.urls} URL(s), mode=${r.submitMode}\n`);
    for (const res of r.results) printOne(res);

    const externals = r.results.filter((x) => x.applyMethod === 'external');
    const submitted = r.results.filter((x) => x.stoppedAt === 'submitted');
    const filled = r.results.filter((x) => x.stoppedAt === 'review');
    const failed = r.results.filter((x) => x.prep === 'prepare-failed' || (x.note && x.note.includes('apply failed')));
    const elig = r.results.filter((x) => x.prep === 'skipped-eligibility');
    process.stdout.write(`\nsummary: ${submitted.length} submitted · ${filled.length} filled/pending · ${externals.length} external · ${elig.length} eligibility-skipped · ${failed.length} failed\n`);
    if (externals.length) {
      process.stdout.write(`\n🔗 Apply manually on the company site (no quick apply):\n`);
      for (const e of externals) process.stdout.write(`   ${e.title ?? e.jobId}\n   → ${e.externalUrl}\n`);
    }
    if (r.journalPath) process.stdout.write(`\ntrace: ${r.journalPath}\n`);
    return;
  }

  // ── batch over DB candidates ──────────────────────────────────────────
  if (batch) {
    const r = await seekApplyBatch({ submit, confirm, headful, minScore, maxApplies });
    process.stdout.write(`\nseek-apply batch — ${r.candidates} candidate(s)\n`);
    for (const res of r.results) printOne(res);
    if (r.journalPath) process.stdout.write(`\ntrace: ${r.journalPath}\n`);
    return;
  }

  // ── single job ────────────────────────────────────────────────────────
  if (!jobIdOrUrl) {
    console.error(
      'Usage:\n' +
        '  career-ops seek-apply <jobIdOrUrl> [--confirm|--submit] [--headful]\n' +
        '  career-ops seek-apply --file <urls.txt> [--confirm|--submit] [--headful]\n' +
        '  career-ops seek-apply --batch [--min-score N] [--max-applies M] [--confirm|--submit]\n\n' +
        '  default: dry-run (fills to review, never submits)\n' +
        '  --confirm: pause at review and ask before submitting each job\n' +
        '  --submit:  auto-submit (also requires SEEK_ALLOW_SUBMIT=true)',
    );
    process.exit(2);
  }

  const r = await seekApply(jobIdOrUrl, { submit, confirm, headful });
  printOne(r);
  if (r.journalPath) process.stdout.write(`  trace: ${r.journalPath}\n`);
}

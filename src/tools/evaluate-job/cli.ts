import { evaluateJob } from './index.js';

const REC_BADGE: Record<string, string> = {
  STRONG: '✅ STRONG',
  BORDERLINE: '⚠️  BORDERLINE',
  SKIP: '❌ SKIP',
  NOT_FOR_YOU: '🚫 NOT FOR YOU',
};

export async function runCli(argv: string[]): Promise<void> {
  let jobIdOrUrl: string | undefined;
  let force = false;
  let reextract = false;
  let json = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) jobIdOrUrl = a;
  }
  if (!jobIdOrUrl) {
    console.error('Usage: career-ops evaluate-job <jobIdOrUrl> [--force] [--reextract] [--json]');
    process.exit(2);
  }

  const result = await evaluateJob(jobIdOrUrl, { force, reextract });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const { job, eligibility, summary, match } = result;
  process.stdout.write(`\n${REC_BADGE[match.recommendation] ?? match.recommendation}  ${match.scoreOutOf5}/5  (${match.fitScore}/100)\n`);
  process.stdout.write(`${job.title} @ ${job.company ?? '?'}  [${job.jobId}]\n`);
  process.stdout.write(`${match.oneLineFit}\n\n`);

  if (eligibility.flags.length) {
    process.stdout.write(`  eligibility blockers:\n`);
    for (const f of eligibility.flags) {
      process.stdout.write(`    🚫 ${f.flag}\n`);
      process.stdout.write(`       "${f.evidence}"\n`);
    }
    return;
  }

  if (summary) {
    process.stdout.write(`  must-haves: ${summary.mustHaveRequirements.length}, nice-to-haves: ${summary.niceToHaveRequirements.length}\n`);
    process.stdout.write(`  domain: ${summary.domain || '—'}, seniority: ${summary.seniority || '—'}\n\n`);
  }
  if (match.strengths.length) {
    process.stdout.write(`  strengths:\n`);
    for (const s of match.strengths.slice(0, 5)) process.stdout.write(`    ✓ ${s.requirement}\n`);
  }
  if (match.gaps.length) {
    process.stdout.write(`  gaps:\n`);
    for (const g of match.gaps.slice(0, 5)) process.stdout.write(`    ✗ ${g.requirement}\n`);
  }
  if (match.recommendation === 'STRONG') {
    process.stdout.write(`\n  → next: career-ops apply-job ${job.jobId}\n`);
  }
}

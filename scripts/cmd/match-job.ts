import { matchJob } from '../../src/tools/match-job/index.js';

const REC_BADGE: Record<string, string> = {
  STRONG: '✅ STRONG',
  BORDERLINE: '⚠️  BORDERLINE',
  SKIP: '❌ SKIP',
  NOT_FOR_YOU: '🚫 NOT FOR YOU',
};

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let force = false;
  let json = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops match-job <jobId> [--force] [--json]');
    process.exit(2);
  }

  const match = await matchJob(jobId, { force });

  if (json) {
    process.stdout.write(JSON.stringify(match, null, 2) + '\n');
    return;
  }

  process.stdout.write(`${REC_BADGE[match.recommendation] ?? match.recommendation}  ${match.scoreOutOf5}/5  (${match.fitScore}/100)\n`);
  process.stdout.write(`  ${match.oneLineFit}\n\n`);
  if (match.strengths.length) {
    process.stdout.write(`  strengths:\n`);
    for (const s of match.strengths) process.stdout.write(`    ✓ ${s.requirement} — ${s.evidence}\n`);
  }
  if (match.gaps.length) {
    process.stdout.write(`  gaps:\n`);
    for (const g of match.gaps) process.stdout.write(`    ✗ ${g.requirement} — ${g.suggestion}\n`);
  }
  if (match.keywordsToEmphasize.length) {
    process.stdout.write(`  keywords: ${match.keywordsToEmphasize.join(', ')}\n`);
  }
}

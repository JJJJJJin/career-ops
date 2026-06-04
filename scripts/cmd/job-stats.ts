import { jobStats } from '../../src/tools/job-stats/index.js';

export async function runCli(argv: string[]): Promise<void> {
  const json = argv.includes('--json');
  const stats = jobStats();
  if (json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n  jobs:        ${stats.totalJobs}\n`);
  process.stdout.write(`    eligible:    ${stats.eligibleJobs}\n`);
  process.stdout.write(`    ineligible:  ${stats.ineligibleJobs}\n\n`);

  process.stdout.write(`  recommendation:\n`);
  for (const [k, v] of Object.entries(stats.byRecommendation)) {
    process.stdout.write(`    ${k.padEnd(13)} ${v}\n`);
  }
  process.stdout.write(`    UNSCORED      ${stats.scoreBuckets.unscored}\n\n`);

  process.stdout.write(`  status:\n`);
  for (const [k, v] of Object.entries(stats.byStatus)) {
    process.stdout.write(`    ${k.padEnd(13)} ${v}\n`);
  }
}

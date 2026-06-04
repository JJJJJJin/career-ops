import { summarizeJob } from '../../src/tools/summarize-job/index.js';

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
    console.error('Usage: career-ops summarize-job <jobId> [--force] [--json]');
    process.exit(2);
  }

  const summary = await summarizeJob(jobId, { force });

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  process.stdout.write(`✔ ${jobId}\n`);
  process.stdout.write(`  ${summary.oneLineSummary}\n\n`);
  process.stdout.write(`  domain:    ${summary.domain}\n`);
  process.stdout.write(`  seniority: ${summary.seniority}\n`);
  process.stdout.write(`  tech:      ${summary.techStack.join(', ') || '—'}\n\n`);
  process.stdout.write(`  must-haves (${summary.mustHaveRequirements.length}):\n`);
  for (const r of summary.mustHaveRequirements) process.stdout.write(`    • ${r}\n`);
  process.stdout.write(`  nice-to-haves (${summary.niceToHaveRequirements.length}):\n`);
  for (const r of summary.niceToHaveRequirements) process.stdout.write(`    • ${r}\n`);
}

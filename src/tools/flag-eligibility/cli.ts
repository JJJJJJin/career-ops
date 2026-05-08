import { flagEligibility } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops flag-eligibility <jobId> [--json]');
    process.exit(2);
  }

  const result = flagEligibility({ jobId });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (result.isEligible) {
    process.stdout.write(`✔ ${jobId} — eligible (no blocking signals)\n`);
    return;
  }
  process.stdout.write(`🚫 ${jobId} — NOT FOR YOU\n`);
  for (const f of result.flags) {
    process.stdout.write(`  • ${f.flag}\n`);
    process.stdout.write(`    "${f.evidence}"\n`);
  }
}

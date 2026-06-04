import path from 'node:path';
import { config } from '../../shared/config.js';
import { assembleResume } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let force = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops assemble-resume <jobId> [--force]');
    process.exit(2);
  }

  const r = await assembleResume(jobId, { force });
  process.stdout.write(`✔ resume assembled (traceability passed) → ${path.relative(config.repoRoot, r.outputDir)}/\n`);
  process.stdout.write(`  archetype: ${r.report.archetype} · experience: ${r.resume.experience.length} · projects: ${r.resume.projects.length}\n`);
  if (r.report.synonymSwaps.length) {
    process.stdout.write(`  synonym swaps: ${r.report.synonymSwaps.map((s) => `${s.from}→${s.to}`).join(', ')}\n`);
  }
  if (r.report.unmetRequirements.length) {
    process.stdout.write(`  ⚠ JD wants (not in library): ${r.report.unmetRequirements.join(', ')}\n`);
  }
  process.stdout.write(`\n  next: career-ops render-resume-pdf ${jobId}\n`);
}

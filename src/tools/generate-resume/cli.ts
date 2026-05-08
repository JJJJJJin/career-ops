import path from 'node:path';
import { config } from '../../shared/config.js';
import { generateResume } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let force = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops generate-resume <jobId> [--force]');
    process.exit(2);
  }

  const r = await generateResume(jobId, { force });
  process.stdout.write(`✔ resume.json + resume.md → ${path.relative(config.repoRoot, r.outputDir)}/\n`);
  process.stdout.write(`  experience: ${r.resume.experience.length}, projects: ${r.resume.projects.length}\n`);
  process.stdout.write(`\n  next: career-ops render-resume-pdf ${jobId}\n`);
}

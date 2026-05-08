import path from 'node:path';
import { config } from '../../shared/config.js';
import { generateCoverLetter } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let force = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops generate-cover-letter <jobId> [--force]');
    process.exit(2);
  }

  const r = await generateCoverLetter(jobId, { force });
  process.stdout.write(`✔ cover_letter.json + cover_letter.md → ${path.relative(config.repoRoot, r.outputDir)}/\n`);
  process.stdout.write(`  paragraphs: ${r.letter.bodyParagraphs.length}\n`);
  process.stdout.write(`\n  next: career-ops render-cover-letter-pdf ${jobId}\n`);
}

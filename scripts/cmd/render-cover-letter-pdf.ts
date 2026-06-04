import path from 'node:path';
import { config } from '../../src/shared/config.js';
import { renderCoverLetterPdf } from '../../src/tools/render-cover-letter-pdf/index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      outPath = argv[i + 1];
      i++;
    } else if (a && !a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops render-cover-letter-pdf <jobId> [--out <path>]');
    process.exit(2);
  }
  const out = await renderCoverLetterPdf(jobId, { outPath });
  process.stdout.write(`✔ ${path.relative(config.repoRoot, out)}\n`);
}

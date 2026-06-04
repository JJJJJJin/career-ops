import { classifyJd } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  const jobId = argv.find((a) => !a.startsWith('--'));
  if (!jobId) {
    console.error('Usage: career-ops classify-jd <jobId>');
    process.exit(2);
  }
  const c = await classifyJd(jobId);
  process.stdout.write(`archetype: ${c.archetype}\n`);
  process.stdout.write(`emphasis:  ${c.emphasisTags.join(', ') || '(none)'}\n`);
  if (c.rationale) process.stdout.write(`why:       ${c.rationale}\n`);
}

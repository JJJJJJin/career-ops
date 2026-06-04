import { goNoGo } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  const jobId = argv.find((a) => !a.startsWith('--'));
  if (!jobId) {
    console.error('Usage: career-ops go-no-go <jobId>');
    process.exit(2);
  }
  const r = await goNoGo(jobId);
  process.stdout.write(`decision: ${r.decision === 'go' ? 'GO ✓' : 'LOW-YIELD ⚠'}\n`);
  for (const reason of r.reasons) process.stdout.write(`  - [${reason.kind}] ${reason.detail}\n`);
}

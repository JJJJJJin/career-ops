import { aggregateGaps } from './index.js';

export async function runCli(argv: string[]): Promise<void> {
  const limit = (() => {
    const i = argv.indexOf('--top');
    return i !== -1 && argv[i + 1] ? parseInt(argv[i + 1], 10) : 25;
  })();

  const rows = aggregateGaps();
  if (!rows.length) {
    process.stdout.write('No gaps recorded yet. Run apply-job / assemble-resume on some JDs first.\n');
    return;
  }
  process.stdout.write(`Cumulative gap report — JD requirements not in your library, ranked by demand:\n\n`);
  process.stdout.write(`  ${'jobs'.padStart(4)}  ${'seen'.padStart(4)}  requirement\n`);
  process.stdout.write(`  ${'─'.repeat(4)}  ${'─'.repeat(4)}  ${'─'.repeat(40)}\n`);
  for (const r of rows.slice(0, limit)) {
    process.stdout.write(`  ${String(r.jobs).padStart(4)}  ${String(r.count).padStart(4)}  ${r.requirement}\n`);
  }
  if (rows.length > limit) process.stdout.write(`\n  …and ${rows.length - limit} more (use --top N).\n`);
}

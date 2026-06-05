import { batchExtract } from '../../src/tools/batch-extract/index.js';

function parseArgs(argv: string[]): {
  urls: string[];
  concurrency: number;
  noStore: boolean;
  json: boolean;
} {
  const urls: string[] = [];
  let concurrency = 4;
  let noStore = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') {
      concurrency = parseInt(argv[++i] ?? '4', 10);
    } else if (a === '--no-store') {
      noStore = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--stdin') {
      // Read URLs from stdin (one per line)
      // handled below
    } else if (!a.startsWith('--')) {
      urls.push(a);
    }
  }
  return { urls, concurrency, noStore, json };
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // If --stdin flag or no URLs provided, read from stdin
  let urls = args.urls;
  const hasStdinFlag = argv.includes('--stdin');
  if (hasStdinFlag || urls.length === 0) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const stdinText = Buffer.concat(chunks).toString('utf-8').trim();
    if (stdinText) {
      urls = [
        ...urls,
        ...stdinText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#')),
      ];
    }
  }

  if (urls.length === 0) {
    process.stderr.write(
      'Usage: career-ops batch-extract <url...> [--concurrency 4] [--no-store] [--json]\n' +
        '       career-ops batch-extract --stdin < urls.txt\n' +
        '       career-ops batch-extract (reads from stdin by default if no args)\n',
    );
    process.exit(2);
  }

  process.stderr.write(`batch-extract: ${urls.length} URLs, concurrency=${args.concurrency}\n`);

  const start = Date.now();
  const result = await batchExtract(urls, {
    concurrency: args.concurrency,
    noStore: args.noStore,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: result.ok.map((j) => ({
            jobId: j.jobId,
            source: j.source,
            title: j.title,
            company: j.company,
            descChars: j.description.length,
          })),
          failed: result.failed,
          elapsedSec: parseFloat(elapsed),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(`\n  ✓ ${result.ok.length} extracted\n`);
    if (result.failed.length > 0) {
      process.stderr.write(`  ✗ ${result.failed.length} failed\n`);
      for (const f of result.failed) {
        process.stderr.write(`    ${f.url}: ${f.error}\n`);
      }
    }
    process.stderr.write(`  ⏱  ${elapsed}s\n`);
  }
}

import { seekSearch, type SearchOptions } from '../../src/tools/seek-search/index.js';

function parseArgs(argv: string[]): SearchOptions & { json: boolean } {
  const opts: SearchOptions & { json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--keyword' || a === '-q') {
      opts.keywords = (opts.keywords ?? []).concat(next ?? '');
      i++;
    } else if (a === '--location') {
      opts.location = next;
      i++;
    } else if (a === '--days') {
      opts.days = parseInt(next ?? '', 10);
      i++;
    } else if (a === '--max') {
      opts.maxJobsPerKeyword = parseInt(next ?? '', 10);
      i++;
    } else if (a === '--include-senior') {
      opts.includeSenior = true;
    } else if (a === '--no-store') {
      opts.noStore = true;
    } else if (a === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const results = await seekSearch(args);

  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }

  const newCount = results.filter((r) => r.isNew).length;
  process.stdout.write(`✔ ${results.length} jobs (${newCount} new)\n`);
  for (const r of results) {
    const tag = r.isNew ? '🆕' : '  ';
    process.stdout.write(`  ${tag} ${r.jobId}  ${r.title} @ ${r.company ?? '?'}  [${r.matchedKeyword}]\n`);
  }
}

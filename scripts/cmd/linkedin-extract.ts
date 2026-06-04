import { linkedinExtract } from '../../src/tools/linkedin-extract/index.js';

function parseArgs(argv: string[]): { url: string; noLlm: boolean; noStore: boolean; reextract: boolean; json: boolean } {
  let url = '';
  let noLlm = false;
  let noStore = false;
  let reextract = false;
  let json = false;
  for (const a of argv) {
    if (a === '--no-llm') noLlm = true;
    else if (a === '--no-store') noStore = true;
    else if (a === '--reextract') reextract = true;
    else if (a === '--json') json = true;
    else if (!a.startsWith('--')) url = a;
  }
  return { url, noLlm, noStore, reextract, json };
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.url) {
    console.error('Usage: career-ops linkedin-extract <linkedin-url> [--no-llm] [--no-store] [--reextract] [--json]');
    process.exit(2);
  }

  const job = await linkedinExtract(args.url, {
    noLlm: args.noLlm,
    noStore: args.noStore,
    reextract: args.reextract,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    return;
  }

  process.stdout.write(`✔ ${job.jobId} — ${job.title} @ ${job.company ?? '?'} (${job.location ?? '?'})\n`);
  process.stdout.write(`  classification: ${job.classification ?? '—'}\n`);
  process.stdout.write(`  work type:      ${job.workType ?? '—'}\n`);
  process.stdout.write(`  salary:         ${job.salaryText ?? '—'}\n`);
  process.stdout.write(`  posted:         ${job.postedDate ?? '—'}\n`);
  process.stdout.write(`  description:    ${job.description.length} chars\n`);
}

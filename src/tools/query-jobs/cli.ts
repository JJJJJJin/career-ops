import { queryJobs, type QueryFilters } from './index.js';
import type { ApplicationStatus } from '../../shared/db/types.js';

const REC_BADGE: Record<string, string> = {
  STRONG: '✅',
  BORDERLINE: '⚠️ ',
  SKIP: '❌',
  NOT_FOR_YOU: '🚫',
};

function parseArgs(argv: string[]): QueryFilters & { json: boolean } {
  const out: QueryFilters & { json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--since-days') {
      out.sinceDays = parseInt(next ?? '', 10);
      i++;
    } else if (a === '--eligible-only') out.eligibleOnly = true;
    else if (a === '--ineligible-only') out.ineligibleOnly = true;
    else if (a === '--min-score') {
      out.minScore = parseFloat(next ?? '');
      i++;
    } else if (a === '--status') {
      out.status = next as ApplicationStatus;
      i++;
    } else if (a === '--company') {
      out.company = next;
      i++;
    } else if (a === '-q' || a === '--keyword') {
      out.keyword = next;
      i++;
    } else if (a === '--limit') {
      out.limit = parseInt(next ?? '', 10);
      i++;
    } else if (a === '--json') out.json = true;
  }
  return out;
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const results = queryJobs(args);

  if (args.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }

  if (results.length === 0) {
    process.stdout.write('(no jobs match)\n');
    return;
  }

  process.stdout.write(`${results.length} job(s)\n\n`);
  for (const { job, application } of results) {
    const score = application?.scoreOutOf5 != null ? `${application.scoreOutOf5.toFixed(1)}/5` : '—';
    const rec = application?.recommendation ? REC_BADGE[application.recommendation] ?? '' : '  ';
    const status = application?.status ?? 'new';
    const company = (job.company ?? '?').padEnd(28).slice(0, 28);
    const title = job.title.padEnd(50).slice(0, 50);
    process.stdout.write(`  ${rec} ${score.padEnd(5)} ${status.padEnd(11)} ${company} ${title} [${job.jobId}]\n`);
  }
}

import { showJob } from '../../src/tools/show-job/index.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (!a.startsWith('--')) jobId = a;
  }
  if (!jobId) {
    console.error('Usage: career-ops show-job <jobId> [--json]');
    process.exit(2);
  }

  const { job, application } = showJob(jobId);

  if (json) {
    process.stdout.write(JSON.stringify({ job, application }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n${job.title}\n`);
  process.stdout.write(`${job.company ?? '?'} — ${job.location ?? '?'}\n`);
  process.stdout.write(`${job.url}\n\n`);
  process.stdout.write(`  job_id:         ${job.jobId}\n`);
  process.stdout.write(`  classification: ${job.classification ?? '—'}\n`);
  process.stdout.write(`  work type:      ${job.workType ?? '—'}\n`);
  process.stdout.write(`  salary:         ${job.salaryText ?? '—'}\n`);
  process.stdout.write(`  posted:         ${job.postedDate ?? '—'}\n`);
  process.stdout.write(`  fetched:        ${job.fetchedAt}\n`);
  process.stdout.write(`  description:    ${job.description.length} chars\n`);

  if (job.eligibilityFlags.length) {
    process.stdout.write(`\n  eligibility flags:\n`);
    for (const f of job.eligibilityFlags) {
      process.stdout.write(`    🚫 ${f.flag}\n       "${f.evidence}"\n`);
    }
  }

  if (application) {
    process.stdout.write(`\n  application:\n`);
    process.stdout.write(`    status:         ${application.status}\n`);
    process.stdout.write(`    score:          ${application.scoreOutOf5 ?? '—'}/5  (${application.fitScore ?? '—'}/100)\n`);
    process.stdout.write(`    recommendation: ${application.recommendation ?? '—'}\n`);
    if (application.oneLineFit) process.stdout.write(`    fit:            ${application.oneLineFit}\n`);
    process.stdout.write(`    output dir:     ${application.outputDir ?? '—'}\n`);
    process.stdout.write(`    generated at:   ${application.generatedAt ?? '—'}\n`);
    process.stdout.write(`    model:          ${application.model ?? '—'}\n`);
    if (application.notes) process.stdout.write(`    notes:          ${application.notes}\n`);
  } else {
    process.stdout.write(`\n  (no application record yet — run \`career-ops evaluate-job ${job.jobId}\`)\n`);
  }
}

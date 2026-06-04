import { markJob } from '../../src/tools/mark-job/index.js';
import { writeTracker } from '../../src/shared/db/view.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let status: string | undefined;
  let notes: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notes' || a === '-n') {
      notes = argv[i + 1];
      i++;
    } else if (a && !a.startsWith('--')) {
      if (!jobId) jobId = a;
      else if (!status) status = a;
    }
  }
  if (!jobId || !status) {
    console.error('Usage: career-ops mark-job <jobId> <new|interested|applied|interview|rejected|offer|skip> [--notes "..."]');
    process.exit(2);
  }

  const r = await markJob(jobId, status, notes);
  const trackerPath = writeTracker();
  process.stdout.write(`✔ ${r.jobId} → ${r.status}  (tracker: ${r.trackerStatus})\n`);
  process.stdout.write(`  tracker view: ${trackerPath}\n`);
}

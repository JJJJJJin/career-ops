// mark-verdict — set the agent's holistic verdict on a job.
// Values: recommended | not_recommended | pending
import { db } from '../../src/shared/db/store.js';

export async function runCli(argv: string[]): Promise<void> {
  let jobId: string | undefined;
  let verdict: string | undefined;
  let reason: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--reason' && i + 1 < argv.length) { reason = argv[++i]; }
    else if (!a.startsWith('--') && !jobId) jobId = a;
    else if (!a.startsWith('--') && !verdict) verdict = a;
    i++;
  }

  if (!jobId || !verdict) {
    console.error('Usage: career-ops mark-verdict <jobId> <recommended|not_recommended|pending> [--reason "..."]');
    process.exit(2);
  }

  if (!['recommended', 'not_recommended', 'pending'].includes(verdict)) {
    console.error(`Invalid verdict: ${verdict}. Must be recommended, not_recommended, or pending.`);
    process.exit(2);
  }

  db.updateApplicationFields(jobId, {
    agentVerdict: verdict,
    ...(reason ? { agentVerdictReason: reason } : {}),
  });

  const emoji = verdict === 'recommended' ? '✅' : verdict === 'not_recommended' ? '❌' : '⏳';
  process.stdout.write(`${emoji} ${jobId} → ${verdict}${reason ? ` (${reason.slice(0, 80)})` : ''}\n`);
}

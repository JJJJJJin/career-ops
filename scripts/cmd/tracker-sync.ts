import { trackerSync } from '../../src/tools/tracker-sync/index.js';
import * as tracker from '../../src/shared/tracker/index.js';

export async function runCli(_argv: string[]): Promise<void> {
  const r = await trackerSync();
  if (!r.enabled) {
    process.stdout.write(`tracker disabled (set TRACKER_DATABASE_URL). ${tracker.pendingCount()} op(s) queued locally.\n`);
    await tracker.close();
    return;
  }
  process.stdout.write(`✔ tracker synced — ${r.synced} op(s) pushed, ${r.pending} still pending.\n`);
  if (r.pending) process.stdout.write(`  (still offline or partial — run again when connected)\n`);
  await tracker.close();
}

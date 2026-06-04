// tracker-sync — ensure the Postgres schema and replay any queued offline ops.
// Run after you regain connectivity (or on a schedule) to push everything that
// was recorded while the tracker was unreachable.
import * as tracker from '../../shared/tracker/index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('tracker-sync');

export type TrackerSyncResult = { enabled: boolean; synced: number; pending: number };

export async function trackerSync(): Promise<TrackerSyncResult> {
  if (!tracker.isEnabled()) {
    return { enabled: false, synced: 0, pending: tracker.pendingCount() };
  }
  try {
    await tracker.ensureSchema();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'tracker-sync: ensureSchema failed (offline?) — will retry next time');
    return { enabled: true, synced: 0, pending: tracker.pendingCount() };
  }
  const { synced, pending } = await tracker.flushOutbox();
  return { enabled: true, synced, pending };
}

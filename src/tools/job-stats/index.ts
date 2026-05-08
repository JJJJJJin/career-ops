// job-stats — totals: by status, recommendation, eligibility.
import { db } from '../../shared/db/store.js';

export type JobStats = ReturnType<typeof db.stats>;

export function jobStats(): JobStats {
  return db.stats();
}

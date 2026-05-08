// query-jobs — read DB with composable filters.
import { db } from '../../shared/db/store.js';
import type { ApplicationRow, ApplicationStatus, SeekJob } from '../../shared/db/types.js';

export type QueryFilters = {
  sinceDays?: number;
  eligibleOnly?: boolean;
  ineligibleOnly?: boolean;
  keyword?: string;
  company?: string;
  minScore?: number;
  status?: ApplicationStatus;
  limit?: number;
};

export type QueryResult = { job: SeekJob; application: ApplicationRow | null };

export function queryJobs(filters: QueryFilters = {}): QueryResult[] {
  return db.listJobs(filters);
}

// show-job — full record + application state for one jobId.
import { db } from '../../shared/db/store.js';
import type { ApplicationRow, Job } from '../../shared/db/types.js';

export type ShowResult = {
  job: Job;
  application: ApplicationRow | null;
};

export function showJob(jobId: string): ShowResult {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`show-job: ${jobId} not found in DB.`);
  const application = db.getApplication(jobId);
  return { job, application };
}

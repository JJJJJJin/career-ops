// mark-job — set application status + optional notes.
import { db } from '../../shared/db/store.js';
import type { ApplicationStatus } from '../../shared/db/types.js';

const VALID_STATUSES: ApplicationStatus[] = ['new', 'interested', 'applied', 'interview', 'rejected', 'offer', 'skip'];

export function markJob(jobId: string, status: string, notes?: string): { jobId: string; status: ApplicationStatus } {
  if (!VALID_STATUSES.includes(status as ApplicationStatus)) {
    throw new Error(
      `mark-job: status must be one of ${VALID_STATUSES.join(' | ')} (got: ${status})`,
    );
  }
  const job = db.getJob(jobId);
  if (!job) throw new Error(`mark-job: ${jobId} not in DB.`);
  db.setStatus(jobId, status as ApplicationStatus, notes);
  return { jobId, status: status as ApplicationStatus };
}

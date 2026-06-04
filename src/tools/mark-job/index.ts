// mark-job — set application status + optional notes. Accepts either an internal
// status (new|interested|applied|interview|rejected|offer|skip) or one of the
// tracker's 8 Chinese statuses. Writes local SQLite AND mirrors to the shared
// Postgres tracker (queues offline).
import { db } from '../../shared/db/store.js';
import * as tracker from '../../shared/tracker/index.js';
import { STATUS_MAP, TRACKER_STATUSES, type TrackerStatus } from '../../shared/tracker/types.js';
import type { ApplicationStatus } from '../../shared/db/types.js';

const VALID_STATUSES: ApplicationStatus[] = ['new', 'interested', 'applied', 'interview', 'rejected', 'offer', 'skip'];

// Reverse map so a Chinese tracker status keeps local SQLite usable.
const TRACKER_TO_INTERNAL: Record<TrackerStatus, ApplicationStatus> = {
  '未申请': 'new',
  '已申请': 'applied',
  '面试中': 'interview',
  '等Offer': 'interview',
  '已通过': 'offer',
  '被拒绝': 'rejected',
  '不适合': 'skip',
  '已过期': 'skip',
};

export async function markJob(jobId: string, status: string, notes?: string): Promise<{ jobId: string; status: ApplicationStatus; trackerStatus: TrackerStatus }> {
  const isInternal = VALID_STATUSES.includes(status as ApplicationStatus);
  const isTracker = (TRACKER_STATUSES as string[]).includes(status);
  if (!isInternal && !isTracker) {
    throw new Error(
      `mark-job: status must be one of [${VALID_STATUSES.join(' | ')}] or [${TRACKER_STATUSES.join(' | ')}] (got: ${status})`,
    );
  }
  const internal: ApplicationStatus = isInternal ? (status as ApplicationStatus) : TRACKER_TO_INTERNAL[status as TrackerStatus];
  const trackerStatus: TrackerStatus = isInternal ? STATUS_MAP[status as ApplicationStatus] : (status as TrackerStatus);

  const job = db.getJob(jobId);
  if (!job) throw new Error(`mark-job: ${jobId} not in DB.`);
  db.setStatus(jobId, internal, notes);
  await tracker.recordStatus(
    { source: job.source, sourceId: job.jobId, company: job.company, title: job.title, url: job.url },
    trackerStatus,
    { notes: notes ?? null },
  );
  return { jobId, status: internal, trackerStatus };
}

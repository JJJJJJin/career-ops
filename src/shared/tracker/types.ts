// Shared-tracker data model. Mirrors the Postgres `jobs` table on the rpi:
//   id, discovered_at, source, source_id, company, title, url, score,
//   status, applied_at, notes, updated_at
// Identity across machines = (source, source_id). source_id is the local jobId.
import type { ApplicationStatus } from '../db/types.js';

/** The 8 tracked statuses (stored verbatim in Postgres). */
export type TrackerStatus =
  | '未申请'   // not applied
  | '已申请'   // applied
  | '面试中'   // interviewing
  | '等Offer'  // awaiting offer
  | '已通过'   // offer / passed
  | '被拒绝'   // rejected
  | '不适合'   // not a fit
  | '已过期';  // expired

export const TRACKER_STATUSES: TrackerStatus[] = [
  '未申请', '已申请', '面试中', '等Offer', '已通过', '被拒绝', '不适合', '已过期',
];

/** Map career-ops' internal application status → the tracker's status. */
export const STATUS_MAP: Record<ApplicationStatus, TrackerStatus> = {
  new: '未申请',
  interested: '未申请',
  applied: '已申请',
  interview: '面试中',
  rejected: '被拒绝',
  offer: '已通过',
  skip: '不适合',
};
// Note: 等Offer and 已过期 have no internal equivalent — set them directly
// (e.g. via mark-job with the Chinese value, or the mailbox-status sync).

export function toTrackerStatus(s: string): TrackerStatus {
  if ((TRACKER_STATUSES as string[]).includes(s)) return s as TrackerStatus;
  return STATUS_MAP[s as ApplicationStatus] ?? '未申请';
}

/** Minimal job identity + fields the tracker stores. */
export type TrackerJobInput = {
  source: string;
  sourceId: string;
  company: string | null;
  title: string;
  url: string;
  score?: number | null;
};

/** A queued op persisted to the outbox when Postgres is unreachable. */
export type OutboxOp =
  | { kind: 'discover'; at: string; job: TrackerJobInput }
  | { kind: 'status'; at: string; source: string; sourceId: string; status: TrackerStatus; appliedAt?: string | null; notes?: string | null };

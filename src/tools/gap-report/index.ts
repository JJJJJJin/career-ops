// gap-report — aggregate every JD requirement the content library does not
// support, ranked by how many postings asked for it. This is the candidate's
// learning roadmap: the top rows are the highest-leverage skills to acquire.
import { db } from '../../shared/db/store.js';
import type { JobSummary } from '../../shared/db/types.js';
import type { AssemblyReport } from '../assemble-resume/types.js';

export type GapRow = { normKey: string; requirement: string; count: number; jobs: number };

/**
 * Record this job's gaps: JD tech with no library support (from the assembly
 * report) plus any hard must-have the candidate fails. Idempotent per job.
 */
export function recordJobGaps(
  jobId: string,
  summary: JobSummary,
  assembly: Pick<AssemblyReport, 'unmetRequirements'>,
  goNoGoReasons: Array<{ kind: string; detail: string }> = [],
): void {
  const gaps: Array<{ requirement: string; kind: string }> = [];
  for (const tech of assembly.unmetRequirements) gaps.push({ requirement: tech, kind: 'tech' });
  for (const r of goNoGoReasons) gaps.push({ requirement: r.detail, kind: 'hard' });
  // Also record explicit must-haves the JD parser flagged as blocking gates.
  for (const h of summary.hardMustHaves ?? []) {
    if (h.kind === 'pervasive_stack' && h.tech) gaps.push({ requirement: h.tech, kind: 'tech' });
  }
  db.recordGaps(jobId, gaps);
}

export function aggregateGaps(): GapRow[] {
  return db.aggregateGaps();
}

// go-no-go — compare a JD's hard must-haves against the real profile. If the
// posting demands something the candidate clearly lacks (5+ years, mandatory PR
// or citizenship, a security clearance, or a core framework that runs through
// the whole role and is absent from the library), mark it `low-yield` with the
// reason so the candidate can skip or apply with eyes open — instead of burning
// an assembly cycle pretending to match.
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { JobSummary } from '../../shared/db/types.js';
import { scanEligibility, getBlockers } from '../flag-eligibility/index.js';
import { summarizeJob } from '../summarize-job/index.js';
import { ensureLibrary } from '../../shared/library/parse.js';
import type { ContentLibrary } from '../../shared/library/types.js';

const log = createLogger('go-no-go');

// The candidate is a recent graduate with ~1-2 years of hands-on experience.
// 5+ years is a hard gate per user policy.
const YEARS_GATE = 5;

export type GoNoGoReason = { kind: string; detail: string };
export type GoNoGoDecision = { jobId: string; decision: 'go' | 'low-yield'; reasons: GoNoGoReason[] };

function libraryBlob(library: ContentLibrary): string {
  return [
    ...library.experience.flatMap((e) => e.bullets.map((b) => b.text)),
    ...library.projects.flatMap((p) => [...p.bullets.map((b) => b.text), ...p.tech]),
    ...library.skills.flatMap((g) => g.items),
  ].join(' \n ').toLowerCase();
}

export type GoNoGoOptions = { summary?: JobSummary };

export async function goNoGo(jobId: string, opts: GoNoGoOptions = {}): Promise<GoNoGoDecision> {
  const job = db.getJob(jobId);
  if (!job) throw new Error(`go-no-go: ${jobId} not in DB. Run seek-extract first.`);
  const summary = opts.summary ?? (await summarizeJob(jobId));
  const { library } = ensureLibrary();
  const blob = libraryBlob(library);
  const reasons: GoNoGoReason[] = [];

  // Regex eligibility — only HARD blockers (citizen/PR/clearance/5+ YoE/senior).
  // NO_VISA_SPONSORSHIP is intentionally NOT a low-yield reason.
  // Scan both title + description (same as flag-eligibility does).
  const allFlags = scanEligibility(`${job.title}\n${job.description}`);
  const blockers = getBlockers(allFlags);
  for (const f of blockers) {
    reasons.push({ kind: f.flag, detail: f.evidence });
  }

  // Structured hard must-haves from the JD parser.
  for (const h of summary.hardMustHaves ?? []) {
    if (h.kind === 'years_experience' && typeof h.years === 'number' && h.years >= YEARS_GATE) {
      reasons.push({ kind: 'years_experience', detail: `requires ${h.years}+ years (profile: ~1-2)` });
    } else if (h.kind === 'citizenship_or_pr') {
      reasons.push({ kind: 'citizenship_or_pr', detail: h.detail || 'citizenship/PR required' });
    } else if (h.kind === 'security_clearance') {
      reasons.push({ kind: 'security_clearance', detail: h.detail || 'security clearance required' });
    } else if (h.kind === 'pervasive_stack' && h.tech) {
      const t = h.tech.toLowerCase().trim();
      if (t && !new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(blob)) {
        reasons.push({ kind: 'pervasive_stack', detail: `built on ${h.tech}, not in profile` });
      }
    }
  }

  // Dedup by detail.
  const deduped = [...new Map(reasons.map((r) => [`${r.kind}:${r.detail}`, r])).values()];
  const decision: GoNoGoDecision['decision'] = deduped.length ? 'low-yield' : 'go';
  log.info({ jobId, decision, reasons: deduped.length }, 'go-no-go: complete');
  return { jobId, decision, reasons: deduped };
}

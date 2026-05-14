// flag-eligibility — scan a JD for citizenship/PR/clearance/no-sponsorship
// signals. Heuristic regex; false positives possible. Snippets of evidence
// are returned alongside flags so the user can verify.
//
// Ported from auto_apply_job/src/job_scraper/eligibility.py — same patterns,
// same conservative bias.
import { db } from '../../shared/db/store.js';
import { createLogger } from '../../shared/logger.js';
import type { EligibilityFlag, Job } from '../../shared/db/types.js';

const log = createLogger('flag-eligibility');

type PatternGroup = {
  flag: EligibilityFlag['flag'];
  label: string;
  patterns: string[];
};

const PATTERN_GROUPS: PatternGroup[] = [
  {
    flag: 'AU_CITIZENSHIP_REQUIRED',
    label: 'AU citizenship required',
    patterns: [
      // "must be an Australian citizen" but NOT "...citizen or permanent resident"
      String.raw`must\s+be\s+(?:an?\s+)?australian\s+citizen(?!\s*(?:s\s+)?(?:or|and|/|,))`,
      String.raw`applicants?\s+must\s+be\s+(?:an?\s+)?australian\s+citizen(?!\s*(?:s\s+)?(?:or|and|/|,))`,
      String.raw`australian\s+citizens?\s+only`,
      String.raw`australian\s+citizenship\s+(?:is\s+)?(?:a\s+)?(?:required|essential|mandatory|prerequisite|requirement|must|preferred)`,
      String.raw`must\s+hold\s+(?:an?\s+)?australian\s+citizenship`,
      String.raw`only\s+open\s+to\s+australian\s+citizens`,
    ],
  },
  {
    flag: 'AU_CITIZENSHIP_OR_PR_REQUIRED',
    label: 'AU citizenship or PR required',
    patterns: [
      // "must be an AU citizen or permanent resident"
      String.raw`(?:must\s+be|applicants?\s+must\s+be|only\s+open\s+to|open\s+to)\s+(?:an?\s+)?(?:australian\s+)?(?:citizens?|permanent\s+residents?|pr)\s+(?:or|and|/)\s+(?:an?\s+)?(?:australian\s+)?(?:citizens?|permanent\s+residents?|pr)\b`,
      String.raw`(?:must\s+have|require[sd]?)\s+(?:australian\s+)?(?:permanent\s+residency|permanent\s+residence|pr\b)`,
      String.raw`\b(?:permanent\s+residency|permanent\s+residence|pr)\s+(?:is\s+)?(?:a\s+)?(?:required|essential|mandatory|requirement)`,
      String.raw`(?:australian\s+)?(?:citizens?|permanent\s+residents?|pr)\s+(?:and|or|/)\s+(?:australian\s+)?(?:citizens?|permanent\s+residents?|pr)\s+only`,
    ],
  },
  {
    flag: 'SECURITY_CLEARANCE_REQUIRED',
    label: 'Security clearance required',
    patterns: [
      String.raw`\bagsva\b`,
      String.raw`\bsecurity\s+clearance\b`,
      String.raw`\bbaseline\s+clearance\b`,
      String.raw`\bnv[\s-]?[12]\b`,
      String.raw`\bnegative\s+vetting\b`,
      String.raw`\bpositive\s+vetting\b`,
      String.raw`\btop\s+secret\s+clearance\b`,
      String.raw`\bability\s+to\s+(?:obtain|hold|gain)\s+(?:an?\s+)?(?:australian\s+)?(?:government\s+)?security\s+clearance\b`,
      String.raw`\beligible\s+(?:to\s+obtain|for)\s+(?:an?\s+)?security\s+clearance\b`,
    ],
  },
  {
    flag: 'NO_VISA_SPONSORSHIP',
    label: 'Visa sponsorship not offered',
    patterns: [
      String.raw`no\s+(?:\w+\s+){0,2}sponsor(?:ship)?`,
      String.raw`unable\s+to\s+(?:\w+\s+){0,3}sponsor(?:ship)?`,
      String.raw`sponsorship\s+(?:is\s+)?not\s+(?:offered|available|provided)`,
      String.raw`cannot\s+(?:\w+\s+){0,3}sponsor(?:ship)?`,
      String.raw`(?:do|will|can)\s+not\s+(?:\w+\s+){0,3}sponsor(?:ship)?`,
      String.raw`not\s+able\s+to\s+(?:\w+\s+){0,3}sponsor(?:ship)?`,
      String.raw`sponsorship\s+will\s+not\s+be\s+(?:provided|offered|available)`,
      String.raw`we\s+do\s+not\s+sponsor`,
      String.raw`this\s+role\s+(?:does\s+not|is\s+not)\s+(?:\w+\s+){0,3}sponsor`,
    ],
  },
];

const COMPILED = PATTERN_GROUPS.map((g) => ({
  flag: g.flag,
  label: g.label,
  regex: new RegExp(g.patterns.map((p) => `(?:${p})`).join('|'), 'i'),
}));

function snippet(text: string, start: number, end: number, ctx = 50): string {
  const a = Math.max(0, start - ctx);
  const b = Math.min(text.length, end + ctx);
  let chunk = text.slice(a, b).replace(/\s+/g, ' ').trim();
  if (a > 0) chunk = '…' + chunk;
  if (b < text.length) chunk = chunk + '…';
  return chunk;
}

export function scanEligibility(text: string): EligibilityFlag[] {
  if (!text) return [];
  const flags: EligibilityFlag[] = [];
  for (const c of COMPILED) {
    const match = c.regex.exec(text);
    if (!match) continue;
    flags.push({
      flag: c.flag,
      evidence: snippet(text, match.index, match.index + match[0].length),
    });
  }
  return flags;
}

export function isEligible(flags: EligibilityFlag[]): boolean {
  return flags.length === 0;
}

export type FlagOptions = {
  jobId?: string;
  /** Inline text to scan (skip DB lookup). */
  text?: string;
  /** Skip persisting the result to the DB. */
  noStore?: boolean;
};

export type FlagResult = {
  jobId: string | null;
  flags: EligibilityFlag[];
  isEligible: boolean;
};

export function flagEligibility(opts: FlagOptions): FlagResult {
  if (opts.text) {
    const flags = scanEligibility(opts.text);
    return { jobId: opts.jobId ?? null, flags, isEligible: isEligible(flags) };
  }
  if (!opts.jobId) {
    throw new Error('flag-eligibility: pass either { jobId } or { text }');
  }
  const job: Job | null = db.getJob(opts.jobId);
  if (!job) throw new Error(`flag-eligibility: job ${opts.jobId} not in DB. Run seek-extract first.`);
  const flags = scanEligibility(job.description);
  if (!opts.noStore) {
    db.setEligibilityFlags(job.jobId, flags);
    log.debug({ jobId: job.jobId, flags: flags.map((f) => f.flag) }, 'flag-eligibility: persisted');
  }
  return { jobId: job.jobId, flags, isEligible: isEligible(flags) };
}
